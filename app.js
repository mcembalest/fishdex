// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // Get a free API key from https://www.maptiler.com/cloud/
    MAPTILER_API_KEY: 'uKW1VenIHpSRLBecotba'
};

// Convert arrays to lookup objects if data.js provides arrays
const fishSpeciesLookup = Array.isArray(fishSpecies)
    ? Object.fromEntries(fishSpecies.map(f => [f.id, f]))
    : fishSpecies;

const fishingLocationsLookup = Array.isArray(fishingLocations)
    ? Object.fromEntries(fishingLocations.map(l => [l.id, l]))
    : fishingLocations;

// Global state
const appState = {
    globe: null,
    selectedLocation: null,
    selectedFish: null,
    activeTab: 'recent',
    filters: {
        caught: 'all'
    },
    hoveredLocationId: null,
    expandedTripId: null
};

// Edit state - stores user corrections as an overlay
const editState = {
    tripEdits: {},           // tripId -> {locationId, date, notes}
    catchEdits: {},          // "tripId-catchIndex" -> {speciesId}
    addedCatches: {},        // tripId -> [{speciesId}]
    deletedCatches: new Set(), // "tripId-catchIndex"
    newTrips: [],            // [{id, locationId, date, catches, photoUrl, notes}]
    newLocations: {},         // locationId -> {id, name, lat, lng, ...}
    hiddenTrips: new Set()    // tripId -> hidden (bad photo/wrong species)
};

const EDIT_STATE_KEY = 'fishdex_edits';

// ============================================
// EDIT STATE PERSISTENCE
// ============================================
function saveEditState() {
    const serializable = {
        tripEdits: editState.tripEdits,
        catchEdits: editState.catchEdits,
        addedCatches: editState.addedCatches,
        deletedCatches: [...editState.deletedCatches],
        newTrips: editState.newTrips,
        newLocations: editState.newLocations,
        hiddenTrips: [...editState.hiddenTrips]
    };
    localStorage.setItem(EDIT_STATE_KEY, JSON.stringify(serializable));
}

function loadEditState() {
    const saved = localStorage.getItem(EDIT_STATE_KEY);
    if (saved) {
        try {
            const data = JSON.parse(saved);
            editState.tripEdits = data.tripEdits || {};
            editState.catchEdits = data.catchEdits || {};
            editState.addedCatches = data.addedCatches || {};
            editState.deletedCatches = new Set(data.deletedCatches || []);
            editState.newTrips = data.newTrips || [];
            editState.newLocations = data.newLocations || {};
            editState.hiddenTrips = new Set(data.hiddenTrips || []);
        } catch (e) {
            console.error('Failed to load edit state:', e);
        }
    }
}

// ============================================
// DATA ACCESSOR FUNCTIONS (merge edits with original)
// ============================================
function getMergedTrip(tripId) {
    const original = userCatchRecords.trips.find(t => t.id === tripId);
    const newTrip = editState.newTrips.find(t => t.id === tripId);
    const base = original || newTrip;
    if (!base) return null;

    const edits = editState.tripEdits[tripId] || {};
    return { ...base, ...edits };
}

function getMergedCatches(tripId) {
    const original = userCatchRecords.trips.find(t => t.id === tripId);
    const newTrip = editState.newTrips.find(t => t.id === tripId);
    const base = original || newTrip;
    if (!base) return [];

    const catches = (base.catches || [])
        .map((c, idx) => {
            const key = `${tripId}-${idx}`;
            if (editState.deletedCatches.has(key)) return null;
            const edits = editState.catchEdits[key] || {};
            return { ...c, ...edits, _index: idx, _isOriginal: true };
        })
        .filter(Boolean);

    // Add new catches
    const added = editState.addedCatches[tripId] || [];
    return [...catches, ...added.map((c, i) => ({ ...c, _isNew: true, _newIndex: i }))];
}

function getMergedLocation(locationId) {
    return editState.newLocations[locationId] || fishingLocationsLookup[locationId];
}

function getAllTrips() {
    const allTrips = [...userCatchRecords.trips, ...editState.newTrips];
    return allTrips.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function isTripEdited(tripId) {
    if (editState.tripEdits[tripId]) return true;
    if (editState.addedCatches[tripId]?.length > 0) return true;

    const original = userCatchRecords.trips.find(t => t.id === tripId);
    if (original) {
        for (let i = 0; i < original.catches.length; i++) {
            const key = `${tripId}-${i}`;
            if (editState.catchEdits[key] || editState.deletedCatches.has(key)) {
                return true;
            }
        }
    }
    return false;
}

function isNewTrip(tripId) {
    return editState.newTrips.some(t => t.id === tripId);
}

function isTripHidden(tripId) {
    return editState.hiddenTrips.has(tripId);
}

function toggleTripHidden(tripId) {
    if (editState.hiddenTrips.has(tripId)) {
        editState.hiddenTrips.delete(tripId);
    } else {
        editState.hiddenTrips.add(tripId);
    }
    saveEditState();
}

function getEditSummary() {
    const tripsEdited = Object.keys(editState.tripEdits).length;
    const catchesEdited = Object.keys(editState.catchEdits).length;
    const catchesAdded = Object.values(editState.addedCatches).reduce((sum, arr) => sum + arr.length, 0);
    const catchesDeleted = editState.deletedCatches.size;
    const tripsAdded = editState.newTrips.length;
    const locationsAdded = Object.keys(editState.newLocations).length;

    return { tripsEdited, catchesEdited, catchesAdded, catchesDeleted, tripsAdded, locationsAdded };
}

function initApp() {
    loadEditState();
    updateHeaderStats();
    renderSidePanel();
    setupEventListeners();
    
    // Delay globe initialization to ensure layout is complete
    // This ensures the side panel is accounted for in layout calculations
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            initGlobe();
        });
    });
}

function calculateLocationStats(locationId) {
    const location = fishingLocationsLookup[locationId];
    if (!location) return { caught: 0, total: 0, caughtSpecies: [] };

    const caughtAtLocation = (location.availableFish || []).filter(fishId =>
        userCatchRecords.species[fishId]?.caught
    );

    return {
        caught: caughtAtLocation.length,
        total: (location.availableFish || []).length,
        caughtSpecies: caughtAtLocation
    };
}

function calculateGlobalStats() {
    const caughtFish = Object.keys(userCatchRecords.species).filter(id =>
        userCatchRecords.species[id]?.caught
    );
    const visitedLocations = new Set(userCatchRecords.trips.map(t => t.locationId));

    // Count total individual catches
    let totalCatches = 0;
    userCatchRecords.trips.forEach(trip => {
        totalCatches += trip.catches.length;
    });

    return {
        caughtSpecies: caughtFish.length,
        locationsVisited: visitedLocations.size,
        totalCatches
    };
}

function updateHeaderStats() {
    const stats = calculateGlobalStats();
    document.getElementById('total-species').textContent = stats.caughtSpecies;
    document.getElementById('total-locations').textContent = stats.locationsVisited;
}

function initGlobe() {
    const container = document.getElementById('globe-container');
    const sidePanel = document.querySelector('.side-panel');
    const locationData = prepareLocationData();

    // Force layout calculation before initializing globe
    // This ensures the container has the correct width accounting for the side panel
    void container.offsetHeight; // Force reflow
    
    // Get the correct dimensions after layout
    // On desktop, explicitly account for side panel width (340px)
    let containerWidth = container.offsetWidth;
    let containerHeight = container.offsetHeight;
    
    // If container width is still full viewport (layout not complete), calculate manually
    if (containerWidth >= window.innerWidth - 50 && sidePanel && window.innerWidth > 768) {
        containerWidth = window.innerWidth - 340;
    }
    
    // Ensure we have valid dimensions
    if (!containerWidth || containerWidth <= 0) {
        containerWidth = Math.max(300, window.innerWidth - 340);
    }
    if (!containerHeight || containerHeight <= 0) {
        containerHeight = window.innerHeight;
    }

    appState.globe = Globe()
        (container)
        .width(containerWidth)
        .height(containerHeight)

        // Dynamic tile engine for high-resolution maps (zooms smoothly)
        .globeTileEngineUrl((x, y, l) =>
            `https://api.maptiler.com/tiles/satellite-v2/${l}/${x}/${y}.jpg?key=${CONFIG.MAPTILER_API_KEY}`
        )
        .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
        .showAtmosphere(true)
        .atmosphereColor('lightskyblue')
        .atmosphereAltitude(0.15)

        // HTML markers for locations (vector-based, scales perfectly)
        .htmlElementsData(locationData)
        .htmlLat(d => d.lat)
        .htmlLng(d => d.lng)
        .htmlAltitude(0.01)
        .htmlElement(d => createMarkerElement(d))

        // Initial view
        .pointOfView({ lat: 20, lng: 0, altitude: 2.5 });

    // Auto-rotation
    appState.globe.controls().autoRotate = false;
    appState.globe.controls().autoRotateSpeed = 0.4;
    appState.globe.controls().enableZoom = true;

    // Function to update globe size
    const updateGlobeSize = () => {
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
            appState.globe.width(container.offsetWidth);
            appState.globe.height(container.offsetHeight);
        }
    };

    // Handle window resize
    window.addEventListener('resize', updateGlobeSize);
    
    // Use ResizeObserver to handle container size changes (including initial layout)
    const resizeObserver = new ResizeObserver(() => {
        updateGlobeSize();
    });
    resizeObserver.observe(container);
    
    // Also ensure correct size after layout is complete (backup for initial load)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            updateGlobeSize();
        });
    });
}

function prepareLocationData() {
    return Object.values(fishingLocationsLookup).map(loc => {
        const stats = calculateLocationStats(loc.id);
        const tripsHere = userCatchRecords.trips.filter(t => t.locationId === loc.id);
        const totalCatches = tripsHere.reduce((sum, t) => sum + t.catches.length, 0);
        return {
            ...loc,
            caught: stats.caught,
            totalCatches,
            hasVisited: stats.caught > 0
        };
    });
}

function getLocationColor(totalCatches) {
    if (totalCatches === 0) return '#666666';       // Never fished
    if (totalCatches <= 2) return '#ff6b6b';        // Just started
    if (totalCatches <= 5) return '#ffa502';        // Getting active
    if (totalCatches <= 10) return '#00d4ff';       // Regular spot
    if (totalCatches <= 20) return '#2ed573';       // Favorite spot
    return '#ffd700';                                // Legendary spot
}

function buildLocationTooltip(location) {
    const stats = calculateLocationStats(location.id);
    const tripsHere = userCatchRecords.trips.filter(t => t.locationId === location.id);
    const totalCatches = tripsHere.reduce((sum, t) => sum + t.catches.length, 0);
    const recentPhotos = getLocationCatchPhotos(location.id, 4);

    const photoGrid = recentPhotos.length > 0 ? `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; margin-top: 8px;">
            ${recentPhotos.map(photo => `
                <img src="${photo}" style="width: 40px; height: 40px; border-radius: 4px; object-fit: cover;" onerror="this.style.display='none';">
            `).join('')}
        </div>
    ` : '';

    return `
        <div style="
            background: rgba(10, 10, 26, 0.95);
            padding: 12px 16px;
            border-radius: 8px;
            border: 1px solid ${getLocationColor(totalCatches)};
            font-family: 'Segoe UI', sans-serif;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            min-width: 180px;
        ">
            <div style="font-weight: 600; color: #00d4ff; margin-bottom: 6px;">
                ${location.name}
            </div>
            <div style="font-size: 12px; color: #fff; display: flex; gap: 16px;">
                <span>${stats.caught} species</span>
                <span>${totalCatches} catches</span>
            </div>
            ${photoGrid}
        </div>
    `;
}

// ============================================
// HTML MARKER CREATION
// ============================================
function createMarkerElement(location) {
    const stats = calculateLocationStats(location.id);
    const tripsHere = userCatchRecords.trips.filter(t => t.locationId === location.id);
    const totalCatches = tripsHere.reduce((sum, t) => sum + t.catches.length, 0);
    const color = getLocationColor(totalCatches);

    // Calculate marker size based on catches (20-32px) - simplified for performance
    const baseSize = 20;
    const maxSize = 32;
    const size = baseSize + Math.min(totalCatches, 20) / 20 * (maxSize - baseSize);

    const el = document.createElement('div');
    el.className = 'globe-marker';
    el.dataset.locationId = location.id;

    // Simple CSS-based marker - much faster than SVG with filters
    el.innerHTML = `
        <div class="marker-dot" style="
            width: ${size}px;
            height: ${size}px;
            background: ${color};
            border: 2px solid rgba(255,255,255,0.9);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.4);
        ">
            <span style="
                font-size: ${Math.max(9, size / 3)}px;
                font-weight: bold;
                color: white;
                text-shadow: 0 1px 2px rgba(0,0,0,0.5);
            ">${totalCatches > 99 ? '99+' : totalCatches}</span>
        </div>
    `;

    // Tooltip on hover
    el.title = `${location.name}\n${stats.caught} species, ${totalCatches} catches`;

    // Hover effect
    el.addEventListener('mouseenter', () => {
        el.classList.add('hovered');
    });

    el.addEventListener('mouseleave', () => {
        el.classList.remove('hovered');
    });

    // Click handler
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        handleLocationClick(location);
    });

    return el;
}

// ============================================
// SIDE PANEL
// ============================================
function renderSidePanel() {
    renderRecentCatches();
    renderFishCatalog();
    renderPersonalRecords();
}

function renderRecentCatches() {
    const container = document.getElementById('recent-catches');
    const recentCatches = getRecentCatches();

    if (recentCatches.length === 0) {
        container.innerHTML = '<p class="empty-state">No catches yet.</p>';
        return;
    }

    container.innerHTML = recentCatches.map(catchItem => {
        const fish = fishSpeciesLookup[catchItem.speciesId];
        const location = fishingLocationsLookup[catchItem.locationId];
        if (!fish || !location) return '';
        const photoPath = getImagePath(catchItem.photoUrl);
        return `
            <div class="catch-card" data-fish-id="${catchItem.speciesId}">
                <div class="catch-icon">
                    ${photoPath
                        ? `<img src="${photoPath}" alt="${fish.name}" class="catch-photo" onerror="this.style.opacity='0';">`
                        : `<div class="fish-placeholder catch-placeholder"></div>`
                    }
                </div>
                <div class="catch-info">
                    <span class="catch-species">${fish.name}</span>
                    <span class="catch-location">${location.name.split(',')[0]}</span>
                    <span class="catch-date">${formatDate(catchItem.date)}</span>
                </div>
            </div>
        `;
    }).join('');
}

function getRecentCatches() {
    const catches = [];
    userCatchRecords.trips.forEach(trip => {
        trip.catches.forEach(catchItem => {
            catches.push({
                ...catchItem,
                date: trip.date,
                locationId: trip.locationId,
                tripId: trip.id,
                photoUrl: trip.photoUrl
            });
        });
    });
    return catches.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
}

function renderFishCatalog() {
    const container = document.getElementById('fish-catalog');
    const { caught } = appState.filters;

    let fishList = Object.entries(fishSpeciesLookup);

    // Apply filters
    if (caught === 'caught') {
        fishList = fishList.filter(([id]) => userCatchRecords.species[id]?.caught);
    } else if (caught === 'uncaught') {
        fishList = fishList.filter(([id]) => !userCatchRecords.species[id]?.caught);
    }

    // Sort alphabetically
    fishList.sort((a, b) => a[1].name.localeCompare(b[1].name));

    container.innerHTML = fishList.map(([fishId, fish]) => {
        const isCaught = userCatchRecords.species[fishId]?.caught;
        const photoPath = isCaught ? getRepresentativePhotoForSpecies(fishId) : null;
        return `
            <div class="catalog-item ${isCaught ? 'caught' : 'uncaught'}"
                 data-fish-id="${fishId}">
                <div class="catalog-icon">
                    ${photoPath
                        ? `<img src="${photoPath}" alt="${fish.name}" class="catalog-photo" onerror="this.style.opacity='0';">`
                        : `<div class="fish-placeholder catalog-placeholder"></div>`
                    }
                </div>
                <span class="catalog-name">${isCaught ? fish.name : '???'}</span>
            </div>
        `;
    }).join('');
}

function renderPersonalRecords() {
    const container = document.getElementById('personal-records');

    container.innerHTML = `
       
        <div class="records-section">
            <h4>Catches by Location</h4>
            ${Object.values(fishingLocationsLookup).map(loc => {
                const stats = calculateLocationStats(loc.id);
                const tripsHere = userCatchRecords.trips.filter(t => t.locationId === loc.id);
                const totalCatches = tripsHere.reduce((sum, t) => sum + t.catches.length, 0);
                if (totalCatches === 0) return '';
                return `
                    <div class="location-progress" data-location-id="${loc.id}">
                        <span class="loc-name">${loc.name.split(',')[0]}</span>
                        <span class="loc-stats">${stats.caught} species · ${totalCatches} catches</span>
                    </div>
                `;
            }).join('') || '<p class="empty-state">No catches yet</p>'}
        </div>
    `;
}


// ============================================
// EVENT HANDLERS
// ============================================
function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            switchTab(tabId);
        });
    });

    // Filter changes
    document.getElementById('filter-caught')?.addEventListener('change', (e) => {
        appState.filters.caught = e.target.value;
        renderFishCatalog();
    });

    // Recent catches clicks
    document.getElementById('recent-catches').addEventListener('click', (e) => {
        const card = e.target.closest('.catch-card');
        if (card) {
            const fishId = card.dataset.fishId;
            showFishModal(fishId);
        }
    });

    // Catalog clicks
    document.getElementById('fish-catalog').addEventListener('click', (e) => {
        const item = e.target.closest('.catalog-item');
        if (item) {
            const fishId = item.dataset.fishId;
            showFishModal(fishId);
        }
    });

    // Records clicks
    document.getElementById('personal-records').addEventListener('click', (e) => {
        const item = e.target.closest('.record-item');
        const locProgress = e.target.closest('.location-progress');

        if (item) {
            const fishId = item.dataset.fishId;
            showFishModal(fishId);
        } else if (locProgress) {
            const locationId = locProgress.dataset.locationId;
            const location = fishingLocationsLookup[locationId];
            if (location) {
                flyToLocation(location);
                showLocationModal(location);
            }
        }
    });

    // Modal close buttons
    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', hideAllModals);
    });

    // Click outside modal to close
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                hideAllModals();
            }
        });
    });

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideAllModals();
    });

    // Fish grid clicks in location modal
    document.getElementById('location-fish-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.fish-card');
        if (card) {
            const fishId = card.dataset.fishId;
            showFishModal(fishId);
        }
    });
}

function handleLocationClick(location) {
    appState.globe.controls().autoRotate = false;

    // Remove previous active state from all markers
    document.querySelectorAll('.globe-marker.active').forEach(el => {
        el.classList.remove('active');
    });

    // Add active state to clicked marker
    const marker = document.querySelector(`.globe-marker[data-location-id="${location.id}"]`);
    if (marker) {
        marker.classList.add('active');
    }

    showLocationModal(location);
}

// ============================================
// CAMERA CONTROLS
// ============================================
function flyToLocation(location) {
    appState.globe.controls().autoRotate = false;
    appState.globe.pointOfView(
        { lat: location.lat, lng: location.lng, altitude: 1.5 },
        1500
    );
}

function showLocationModal(location) {
    appState.selectedLocation = location;
    const stats = calculateLocationStats(location.id);
    const trips = userCatchRecords.trips.filter(t => t.locationId === location.id);
    const totalCatches = trips.reduce((sum, t) => sum + t.catches.length, 0);

    // Populate header
    document.getElementById('location-name').textContent = location.name;
    document.getElementById('loc-caught').textContent = stats.caught;
    document.getElementById('loc-total-catches').textContent = totalCatches;

    // Render fish grid
    renderLocationFishGrid(location, stats);

    // Render trip history
    renderTripHistory(trips);

    document.getElementById('location-modal').classList.remove('hidden');
}

function renderLocationFishGrid(location, stats) {
    const grid = document.getElementById('location-fish-grid');

    grid.innerHTML = location.availableFish.map(fishId => {
        const fish = fishSpeciesLookup[fishId];
        if (!fish) return '';
        const isCaught = userCatchRecords.species[fishId]?.caught;
        const userRecord = userCatchRecords.species[fishId];
        const photoPath = isCaught ? getRepresentativePhotoForSpecies(fishId) : null;

        return `
            <div class="fish-card ${isCaught ? 'caught' : 'uncaught'}"
                 data-fish-id="${fishId}">
                <div class="fish-card-image">
                    ${photoPath
                        ? `<img src="${photoPath}" alt="${fish.name}" class="fish-card-photo" onerror="this.style.opacity='0';">`
                        : `<div class="fish-placeholder fish-card-placeholder"></div>`
                    }
                </div>
                <div class="fish-card-info">
                    <span class="fish-card-name">${isCaught ? fish.name : '???'}</span>
                </div>
                ${isCaught && userRecord ? `<span class="catch-count">x${userRecord.totalCaught}</span>` : ''}
            </div>
        `;
    }).join('');
}

function renderTripHistory(trips) {
    const container = document.getElementById('location-trips');

    if (trips.length === 0) {
        container.innerHTML = '<p class="empty-state">No trips recorded at this location yet.</p>';
        return;
    }

    const sortedTrips = [...trips].sort((a, b) => new Date(b.date) - new Date(a.date));

    container.innerHTML = sortedTrips.map(trip => {
        const photoPath = getImagePath(trip.photoUrl);
        return `
            <div class="trip-card">
                ${photoPath ? `
                    <div class="trip-photo-container">
                        <img src="${photoPath}" alt="Trip photo" class="trip-photo" onerror="this.parentElement.style.display='none';">
                    </div>
                ` : ''}
                <div class="trip-header">
                    <span class="trip-date">${formatDate(trip.date)}</span>
                    <span class="trip-catch-count">${trip.catches.length} species</span>
                </div>
                <div class="trip-catches">
                    ${trip.catches.map(c => {
                        const fish = fishSpeciesLookup[c.speciesId];
                        if (!fish) return '';
                        return `<span class="trip-fish">${fish.name}</span>`;
                    }).join('')}
                </div>
                ${trip.notes ? `<p class="trip-notes">"${trip.notes}"</p>` : ''}
            </div>
        `;
    }).join('');
}

function showFishModal(fishId) {
    const fish = fishSpeciesLookup[fishId];
    if (!fish) return;

    const userRecord = userCatchRecords.species[fishId];
    const isCaught = userRecord?.caught;

    appState.selectedFish = fish;

    // Fish image/icon
    const fishImage = document.getElementById('fish-image');
    fishImage.className = `fish-image ${isCaught ? '' : 'uncaught'}`;

    if (isCaught) {
        const photoPath = getRepresentativePhotoForSpecies(fishId);
        if (photoPath) {
            fishImage.innerHTML = `
                <img src="${photoPath}" alt="${fish.name}" class="fish-modal-photo" onerror="this.style.opacity='0';">
            `;
        } else {
            fishImage.innerHTML = `<div class="fish-placeholder fish-modal-placeholder"></div>`;
        }
    } else {
        fishImage.innerHTML = `<div class="fish-placeholder fish-modal-placeholder"></div>`;
    }

    // Basic info
    document.getElementById('fish-name').textContent = isCaught ? fish.name : '???';
    document.getElementById('fish-scientific').textContent = isCaught ? fish.scientificName : 'Unknown Species';

    // Personal records section
    const personalSection = document.getElementById('personal-catch-info');
    if (isCaught && userRecord) {
        personalSection.classList.remove('hidden');
        document.getElementById('first-catch-date').textContent = formatDate(userRecord.firstCatchDate);
        document.getElementById('times-caught').textContent = userRecord.totalCaught;

        // Get the first location where this species was caught
        const firstTrip = userCatchRecords.trips
            .filter(t => t.catches.some(c => c.speciesId === fishId))
            .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
        const firstLocation = firstTrip ? fishingLocationsLookup[firstTrip.locationId] : null;
        document.getElementById('caught-location').textContent = firstLocation?.name.split(',')[0] || 'Unknown';
    } else {
        personalSection.classList.add('hidden');
    }

    // Photo gallery
    const galleryContainer = document.getElementById('fish-photo-gallery');
    if (isCaught) {
        const allPhotos = getAllPhotosForSpecies(fishId);
        if (allPhotos.length > 0) {
            galleryContainer.classList.remove('hidden');
            galleryContainer.innerHTML = `
                <div class="photo-gallery-scroll">
                    ${allPhotos.map(photo => {
                        const location = fishingLocationsLookup[photo.locationId];
                        const locationName = location ? location.name.split(',')[0] : 'Unknown';
                        return `
                            <div class="gallery-photo-item">
                                <img src="${photo.url}" alt="${fish.name}" onerror="this.style.opacity='0';">
                                <div class="gallery-photo-info">
                                    <div class="gallery-photo-date">${formatDate(photo.date)}</div>
                                    <div class="gallery-photo-location">${locationName}</div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        } else {
            galleryContainer.classList.add('hidden');
        }
    } else {
        galleryContainer.classList.add('hidden');
    }

    document.getElementById('fish-modal').classList.remove('hidden');
}

// ============================================
// MODAL CONTROLS
// ============================================
function hideAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.add('hidden');
    });
    appState.selectedLocation = null;
    appState.selectedFish = null;
}

// ============================================
// UTILITIES
// ============================================
function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

const IMAGE_BASE_URL = 'https://pub-4100134b33df405781be0ad11631634d.r2.dev';

function getImagePath(photoUrl) {
    if (!photoUrl) return null;
    // Strip the michaelcembalest/ prefix since images are in bucket root
    const filename = photoUrl.replace('michaelcembalest/', '');
    return `${IMAGE_BASE_URL}/${filename}`;
}

function getRepresentativePhotoForSpecies(speciesId) {
    const tripsWithSpecies = userCatchRecords.trips
        .filter(trip =>
            trip.catches.some(c => c.speciesId === speciesId) &&
            trip.photoUrl &&
            !isTripHidden(trip.id)
        )
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    return tripsWithSpecies[0] ? getImagePath(tripsWithSpecies[0].photoUrl) : null;
}

function getLocationCatchPhotos(locationId, limit = 4) {
    return userCatchRecords.trips
        .filter(trip =>
            trip.locationId === locationId &&
            trip.photoUrl &&
            !isTripHidden(trip.id)
        )
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, limit)
        .map(trip => getImagePath(trip.photoUrl));
}

function getAllPhotosForSpecies(speciesId) {
    return userCatchRecords.trips
        .filter(trip =>
            trip.catches.some(c => c.speciesId === speciesId) &&
            trip.photoUrl &&
            !isTripHidden(trip.id)
        )
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(trip => ({
            url: getImagePath(trip.photoUrl),
            date: trip.date,
            locationId: trip.locationId,
            tripId: trip.id
        }));
}

// ============================================
// EDIT TAB
// ============================================
function renderEditTab() {
    const container = document.getElementById('edit-trips-list');
    const allTrips = getAllTrips();

    if (allTrips.length === 0) {
        container.innerHTML = '<p class="empty-state">No trips to edit.</p>';
        return;
    }

    container.innerHTML = allTrips.map(trip => {
        const mergedTrip = getMergedTrip(trip.id);
        const location = getMergedLocation(mergedTrip.locationId);
        const catches = getMergedCatches(trip.id);
        const isEdited = isTripEdited(trip.id);
        const isNew = isNewTrip(trip.id);
        const isExpanded = appState.expandedTripId === trip.id;
        const photoPath = getImagePath(mergedTrip.photoUrl);

        return `
            <div class="edit-trip-card ${isEdited ? 'has-edits' : ''} ${isNew ? 'is-new' : ''} ${isExpanded ? 'expanded' : ''}"
                 data-trip-id="${trip.id}">
                <div class="edit-trip-header" data-trip-id="${trip.id}">
                    <div class="edit-trip-photo">
                        ${photoPath
                            ? `<img src="${photoPath}" alt="Trip photo" onerror="this.style.opacity='0';">`
                            : '<div class="photo-placeholder"></div>'
                        }
                    </div>
                    <div class="edit-trip-summary">
                        <span class="edit-trip-date">${formatDate(mergedTrip.date)}</span>
                        <span class="edit-trip-location">${location?.name || 'Unknown Location'}</span>
                        <span class="edit-trip-catches">${catches.length} catch${catches.length !== 1 ? 'es' : ''}</span>
                    </div>
                    <div class="edit-trip-badges">
                        ${isNew ? '<span class="edit-badge new">NEW</span>' : ''}
                        ${isEdited && !isNew ? '<span class="edit-badge edited">EDITED</span>' : ''}
                    </div>
                    <span class="expand-icon">${isExpanded ? '−' : '+'}</span>
                </div>
                ${isExpanded ? renderTripEditForm(trip.id, mergedTrip, catches) : ''}
            </div>
        `;
    }).join('');
}

function renderTripEditForm(tripId, trip, catches) {
    const allLocations = { ...fishingLocationsLookup, ...editState.newLocations };
    const sortedLocations = Object.values(allLocations).sort((a, b) => a.name.localeCompare(b.name));
    const sortedSpecies = Object.values(fishSpeciesLookup).sort((a, b) => a.name.localeCompare(b.name));

    return `
        <div class="edit-trip-form">
            <div class="form-row">
                <label>Date</label>
                <input type="date" class="edit-input edit-trip-date-input"
                       value="${trip.date}" data-trip-id="${tripId}">
            </div>
            <div class="form-row">
                <label>Location</label>
                <select class="edit-select edit-trip-location-select" data-trip-id="${tripId}">
                    ${sortedLocations.map(loc =>
                        `<option value="${loc.id}" ${loc.id === trip.locationId ? 'selected' : ''}>${loc.name}</option>`
                    ).join('')}
                </select>
                <button class="link-btn add-location-btn" data-trip-id="${tripId}">+ New</button>
            </div>
            <div class="form-row">
                <label>Catches</label>
                <div class="catches-list">
                    ${catches.map((c, idx) => `
                        <div class="catch-edit-row ${c._isNew ? 'is-new-catch' : ''}"
                             data-trip-id="${tripId}"
                             data-catch-index="${c._isOriginal ? c._index : 'new-' + c._newIndex}">
                            <select class="edit-select catch-species-select">
                                ${sortedSpecies.map(sp =>
                                    `<option value="${sp.id}" ${sp.id === c.speciesId ? 'selected' : ''}>${sp.name}</option>`
                                ).join('')}
                            </select>
                            <button class="delete-catch-btn" title="Delete catch">&times;</button>
                        </div>
                    `).join('')}
                </div>
                <button class="add-catch-btn" data-trip-id="${tripId}">+ Add Catch</button>
            </div>
            <div class="form-row">
                <label>Notes</label>
                <textarea class="edit-textarea edit-trip-notes" data-trip-id="${tripId}"
                          placeholder="Trip notes...">${trip.notes || ''}</textarea>
            </div>
            <div class="form-row hide-photo-row">
                <label>
                    <input type="checkbox" class="hide-photo-checkbox" data-trip-id="${tripId}"
                           ${isTripHidden(tripId) ? 'checked' : ''}>
                    <span>Hide Photo (wrong species or bad photo)</span>
                </label>
            </div>
            <div class="edit-trip-actions">
                ${!isNewTrip(tripId) ? `<button class="action-btn secondary revert-trip-btn" data-trip-id="${tripId}">Revert Changes</button>` : ''}
                ${isNewTrip(tripId) ? `<button class="action-btn secondary delete-trip-btn" data-trip-id="${tripId}">Delete Trip</button>` : ''}
            </div>
        </div>
    `;
}

function switchTab(tabId) {
    // Update button states
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    // Update content visibility
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tabId}`);
    });

    appState.activeTab = tabId;

    // Render edit tab when switching to it
    if (tabId === 'edit') {
        renderEditTab();
    }
}

// ============================================
// EDIT HANDLERS
// ============================================
function handleTripExpand(tripId) {
    if (appState.expandedTripId === tripId) {
        appState.expandedTripId = null;
    } else {
        appState.expandedTripId = tripId;
    }
    renderEditTab();
}

function handleTripDateEdit(tripId, newDate) {
    editState.tripEdits[tripId] = editState.tripEdits[tripId] || {};
    editState.tripEdits[tripId].date = newDate;
    saveEditState();
}

function handleTripLocationEdit(tripId, newLocationId) {
    editState.tripEdits[tripId] = editState.tripEdits[tripId] || {};
    editState.tripEdits[tripId].locationId = newLocationId;
    saveEditState();
}

function handleTripNotesEdit(tripId, newNotes) {
    editState.tripEdits[tripId] = editState.tripEdits[tripId] || {};
    editState.tripEdits[tripId].notes = newNotes;
    saveEditState();
}

function handleCatchSpeciesEdit(tripId, catchIndex, newSpeciesId) {
    if (typeof catchIndex === 'string' && catchIndex.startsWith('new-')) {
        // Editing a newly added catch
        const newIndex = parseInt(catchIndex.replace('new-', ''));
        if (editState.addedCatches[tripId] && editState.addedCatches[tripId][newIndex]) {
            editState.addedCatches[tripId][newIndex].speciesId = newSpeciesId;
        }
    } else {
        const key = `${tripId}-${catchIndex}`;
        editState.catchEdits[key] = editState.catchEdits[key] || {};
        editState.catchEdits[key].speciesId = newSpeciesId;
    }
    saveEditState();
}

function handleAddCatch(tripId) {
    editState.addedCatches[tripId] = editState.addedCatches[tripId] || [];
    // Default to first species alphabetically
    const firstSpecies = Object.values(fishSpeciesLookup).sort((a, b) => a.name.localeCompare(b.name))[0];
    editState.addedCatches[tripId].push({
        speciesId: firstSpecies?.id || 'unknown'
    });
    saveEditState();
    renderEditTab();
}

function handleDeleteCatch(tripId, catchIndex) {
    if (typeof catchIndex === 'string' && catchIndex.startsWith('new-')) {
        // Deleting a newly added catch
        const newIndex = parseInt(catchIndex.replace('new-', ''));
        if (editState.addedCatches[tripId]) {
            editState.addedCatches[tripId].splice(newIndex, 1);
            if (editState.addedCatches[tripId].length === 0) {
                delete editState.addedCatches[tripId];
            }
        }
    } else {
        const key = `${tripId}-${catchIndex}`;
        editState.deletedCatches.add(key);
    }
    saveEditState();
    renderEditTab();
}

function handleRevertTrip(tripId) {
    // Remove all edits for this trip
    delete editState.tripEdits[tripId];
    delete editState.addedCatches[tripId];

    // Remove catch edits and deletions
    const trip = userCatchRecords.trips.find(t => t.id === tripId);
    if (trip) {
        for (let i = 0; i < trip.catches.length; i++) {
            const key = `${tripId}-${i}`;
            delete editState.catchEdits[key];
            editState.deletedCatches.delete(key);
        }
    }

    saveEditState();
    renderEditTab();
}

function handleDeleteNewTrip(tripId) {
    const idx = editState.newTrips.findIndex(t => t.id === tripId);
    if (idx !== -1) {
        editState.newTrips.splice(idx, 1);
        delete editState.addedCatches[tripId];
        appState.expandedTripId = null;
        saveEditState();
        renderEditTab();
    }
}

// ============================================
// ADD TRIP
// ============================================
let newTripCatches = [];

function showAddTripModal() {
    newTripCatches = [];
    populateLocationDropdown('new-trip-location');
    document.getElementById('new-trip-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('new-trip-notes').value = '';
    renderNewTripCatches();
    document.getElementById('add-trip-modal').classList.remove('hidden');
}

function populateLocationDropdown(selectId) {
    const select = document.getElementById(selectId);
    const allLocations = { ...fishingLocationsLookup, ...editState.newLocations };
    const sortedLocations = Object.values(allLocations).sort((a, b) => a.name.localeCompare(b.name));

    select.innerHTML = sortedLocations.map(loc =>
        `<option value="${loc.id}">${loc.name}</option>`
    ).join('');
}

function renderNewTripCatches() {
    const container = document.getElementById('new-trip-catches');
    const sortedSpecies = Object.values(fishSpeciesLookup).sort((a, b) => a.name.localeCompare(b.name));

    container.innerHTML = newTripCatches.map((c, idx) => `
        <div class="catch-edit-row" data-index="${idx}">
            <select class="edit-select new-catch-species">
                ${sortedSpecies.map(sp =>
                    `<option value="${sp.id}" ${sp.id === c.speciesId ? 'selected' : ''}>${sp.name}</option>`
                ).join('')}
            </select>
            <button class="delete-catch-btn delete-new-catch-btn">&times;</button>
        </div>
    `).join('');
}

function saveNewTrip() {
    const date = document.getElementById('new-trip-date').value;
    const locationId = document.getElementById('new-trip-location').value;
    const notes = document.getElementById('new-trip-notes').value;

    if (!date || !locationId) {
        alert('Please fill in date and location.');
        return;
    }

    if (newTripCatches.length === 0) {
        alert('Please add at least one catch.');
        return;
    }

    // Generate new trip ID
    const maxId = Math.max(
        ...userCatchRecords.trips.map(t => t.id),
        ...editState.newTrips.map(t => t.id),
        0
    );

    const newTrip = {
        id: maxId + 1,
        locationId,
        date,
        catches: newTripCatches.map(c => ({ speciesId: c.speciesId })),
        photoUrl: null,
        notes: notes || null
    };

    editState.newTrips.push(newTrip);
    saveEditState();

    document.getElementById('add-trip-modal').classList.add('hidden');
    renderEditTab();
}

// ============================================
// ADD LOCATION
// ============================================
let addLocationCallback = null;

function showAddLocationModal(callback) {
    addLocationCallback = callback;
    document.getElementById('new-location-name').value = '';
    document.getElementById('new-location-lat').value = '';
    document.getElementById('new-location-lng').value = '';
    document.getElementById('add-location-modal').classList.remove('hidden');
}

function saveNewLocation() {
    const name = document.getElementById('new-location-name').value.trim();
    const lat = parseFloat(document.getElementById('new-location-lat').value);
    const lng = parseFloat(document.getElementById('new-location-lng').value);

    if (!name) {
        alert('Please enter a location name.');
        return;
    }

    if (isNaN(lat) || isNaN(lng)) {
        alert('Please enter valid coordinates.');
        return;
    }

    // Generate ID from name
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const newLocation = {
        id,
        name,
        lat,
        lng,
        description: `Fishing destination: ${name}`,
        availableFish: []
    };

    editState.newLocations[id] = newLocation;
    saveEditState();

    document.getElementById('add-location-modal').classList.add('hidden');

    if (addLocationCallback) {
        addLocationCallback(id);
        addLocationCallback = null;
    }
}

// ============================================
// EXPORT
// ============================================
function showExportModal() {
    const summary = getEditSummary();
    const container = document.getElementById('export-summary');

    const changes = [];
    if (summary.tripsAdded > 0) changes.push(`${summary.tripsAdded} new trip(s)`);
    if (summary.tripsEdited > 0) changes.push(`${summary.tripsEdited} trip(s) modified`);
    if (summary.catchesEdited > 0) changes.push(`${summary.catchesEdited} catch(es) edited`);
    if (summary.catchesAdded > 0) changes.push(`${summary.catchesAdded} catch(es) added`);
    if (summary.catchesDeleted > 0) changes.push(`${summary.catchesDeleted} catch(es) deleted`);
    if (summary.locationsAdded > 0) changes.push(`${summary.locationsAdded} new location(s)`);

    if (changes.length === 0) {
        container.innerHTML = '<p>No changes to export.</p>';
    } else {
        container.innerHTML = `
            <p><strong>Changes to export:</strong></p>
            <ul>${changes.map(c => `<li>${c}</li>`).join('')}</ul>
        `;
    }

    document.getElementById('export-modal').classList.remove('hidden');
}

function generateExportData() {
    // Merge locations
    const allLocations = { ...fishingLocationsLookup, ...editState.newLocations };

    // Process trips with all edits applied
    const processedTrips = getAllTrips().map(trip => {
        const merged = getMergedTrip(trip.id);
        const catches = getMergedCatches(trip.id);

        return {
            id: trip.id,
            locationId: merged.locationId,
            date: merged.date,
            catches: catches.map(c => ({ speciesId: c.speciesId })),
            photoUrl: merged.photoUrl,
            notes: merged.notes || null
        };
    }).sort((a, b) => a.id - b.id);

    // Recalculate species stats
    const speciesStats = {};
    processedTrips.forEach(trip => {
        trip.catches.forEach(c => {
            if (!speciesStats[c.speciesId]) {
                speciesStats[c.speciesId] = {
                    caught: true,
                    firstCatchDate: trip.date,
                    totalCaught: 0,
                    personalBest: null
                };
            }

            const stats = speciesStats[c.speciesId];
            stats.totalCaught++;

            if (trip.date < stats.firstCatchDate) {
                stats.firstCatchDate = trip.date;
            }

        });
    });

    // Update availableFish for locations
    Object.values(allLocations).forEach(loc => {
        const speciesAtLocation = new Set();
        processedTrips
            .filter(t => t.locationId === loc.id)
            .forEach(t => t.catches.forEach(c => speciesAtLocation.add(c.speciesId)));
        loc.availableFish = [...speciesAtLocation];
    });

    return {
        fishSpecies: fishSpeciesLookup,
        fishingLocations: allLocations,
        userCatchRecords: {
            species: speciesStats,
            trips: processedTrips
        }
    };
}

function downloadDataJs() {
    const data = generateExportData();
    const timestamp = new Date().toISOString();

    const content = `// FishDex Data - Edited Export
// Generated: ${timestamp}

const fishSpecies = ${JSON.stringify(data.fishSpecies, null, 2)};

const fishingLocations = ${JSON.stringify(data.fishingLocations, null, 2)};

const userCatchRecords = ${JSON.stringify(data.userCatchRecords, null, 2)};
`;

    const blob = new Blob([content], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'data.js';
    a.click();
    URL.revokeObjectURL(url);

    document.getElementById('export-modal').classList.add('hidden');
}

function setupEditEventListeners() {
    const editList = document.getElementById('edit-trips-list');

    // Trip expand/collapse
    editList.addEventListener('click', (e) => {
        const header = e.target.closest('.edit-trip-header');
        if (header && !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) {
            const tripId = parseInt(header.dataset.tripId);
            handleTripExpand(tripId);
        }

        // Add catch button
        if (e.target.classList.contains('add-catch-btn')) {
            const tripId = parseInt(e.target.dataset.tripId);
            handleAddCatch(tripId);
        }

        // Delete catch button
        if (e.target.classList.contains('delete-catch-btn')) {
            const row = e.target.closest('.catch-edit-row');
            if (row) {
                const tripId = parseInt(row.dataset.tripId);
                const catchIndex = row.dataset.catchIndex;
                handleDeleteCatch(tripId, isNaN(parseInt(catchIndex)) ? catchIndex : parseInt(catchIndex));
            }
        }

        // Revert trip button
        if (e.target.classList.contains('revert-trip-btn')) {
            const tripId = parseInt(e.target.dataset.tripId);
            if (confirm('Revert all changes to this trip?')) {
                handleRevertTrip(tripId);
            }
        }

        // Delete new trip button
        if (e.target.classList.contains('delete-trip-btn')) {
            const tripId = parseInt(e.target.dataset.tripId);
            if (confirm('Delete this trip?')) {
                handleDeleteNewTrip(tripId);
            }
        }

        // Add location button in edit form
        if (e.target.classList.contains('add-location-btn')) {
            const tripId = parseInt(e.target.dataset.tripId);
            showAddLocationModal((newLocId) => {
                handleTripLocationEdit(tripId, newLocId);
                renderEditTab();
            });
        }
    });

    // Input changes in edit list
    editList.addEventListener('change', (e) => {
        if (e.target.classList.contains('edit-trip-date-input')) {
            const tripId = parseInt(e.target.dataset.tripId);
            handleTripDateEdit(tripId, e.target.value);
        }

        if (e.target.classList.contains('edit-trip-location-select')) {
            const tripId = parseInt(e.target.dataset.tripId);
            handleTripLocationEdit(tripId, e.target.value);
        }

        if (e.target.classList.contains('catch-species-select')) {
            const row = e.target.closest('.catch-edit-row');
            const tripId = parseInt(row.dataset.tripId);
            const catchIndex = row.dataset.catchIndex;
            handleCatchSpeciesEdit(tripId, isNaN(parseInt(catchIndex)) ? catchIndex : parseInt(catchIndex), e.target.value);
        }

        if (e.target.classList.contains('hide-photo-checkbox')) {
            const tripId = parseInt(e.target.dataset.tripId);
            toggleTripHidden(tripId);
        }

    });

    // Notes blur
    editList.addEventListener('blur', (e) => {
        if (e.target.classList.contains('edit-trip-notes')) {
            const tripId = parseInt(e.target.dataset.tripId);
            handleTripNotesEdit(tripId, e.target.value);
        }
    }, true);

    // Add Trip button
    document.getElementById('add-trip-btn').addEventListener('click', showAddTripModal);

    // Export button
    document.getElementById('export-btn').addEventListener('click', showExportModal);

    // Add Trip modal events
    document.getElementById('add-catch-to-new-trip-btn').addEventListener('click', () => {
        const firstSpecies = Object.values(fishSpeciesLookup).sort((a, b) => a.name.localeCompare(b.name))[0];
        newTripCatches.push({ speciesId: firstSpecies?.id || 'unknown' });
        renderNewTripCatches();
    });

    document.getElementById('new-trip-catches').addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-new-catch-btn')) {
            const row = e.target.closest('.catch-edit-row');
            const idx = parseInt(row.dataset.index);
            newTripCatches.splice(idx, 1);
            renderNewTripCatches();
        }
    });

    document.getElementById('new-trip-catches').addEventListener('change', (e) => {
        const row = e.target.closest('.catch-edit-row');
        if (!row) return;
        const idx = parseInt(row.dataset.index);

        if (e.target.classList.contains('new-catch-species')) {
            newTripCatches[idx].speciesId = e.target.value;
        }
    });

    document.getElementById('save-new-trip-btn').addEventListener('click', saveNewTrip);
    document.getElementById('cancel-new-trip-btn').addEventListener('click', () => {
        document.getElementById('add-trip-modal').classList.add('hidden');
    });

    document.getElementById('add-location-from-trip-btn').addEventListener('click', () => {
        showAddLocationModal((newLocId) => {
            populateLocationDropdown('new-trip-location');
            document.getElementById('new-trip-location').value = newLocId;
        });
    });

    // Add Location modal events
    document.getElementById('save-new-location-btn').addEventListener('click', saveNewLocation);
    document.getElementById('cancel-new-location-btn').addEventListener('click', () => {
        document.getElementById('add-location-modal').classList.add('hidden');
        addLocationCallback = null;
    });

    // Export modal events
    document.getElementById('confirm-export-btn').addEventListener('click', downloadDataJs);
    document.getElementById('cancel-export-btn').addEventListener('click', () => {
        document.getElementById('export-modal').classList.add('hidden');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initApp();
    setupEditEventListeners();
});
