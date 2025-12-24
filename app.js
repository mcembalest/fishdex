
// Global state
const appState = {
    globe: null,
    selectedLocation: null,
    selectedFish: null,
    activeTab: 'recent',
    filters: {
        caught: 'all'
    },
    hoveredLocationId: null
};

function initApp() {
    initGlobe();
    updateHeaderStats();
    renderSidePanel();
    setupEventListeners();
}

function calculateLocationStats(locationId) {
    const location = fishingLocations[locationId];
    if (!location) return { caught: 0, total: 0, caughtSpecies: [] };

    const caughtAtLocation = location.availableFish.filter(fishId =>
        userCatchRecords.species[fishId]?.caught
    );

    return {
        caught: caughtAtLocation.length,
        total: location.availableFish.length,
        caughtSpecies: caughtAtLocation
    };
}

function calculateGlobalStats() {
    const caughtFish = Object.keys(userCatchRecords.species).filter(id =>
        userCatchRecords.species[id]?.caught
    );
    const visitedLocations = new Set(userCatchRecords.trips.map(t => t.locationId));

    // Find biggest catch
    let biggestCatch = null;
    Object.entries(userCatchRecords.species).forEach(([id, record]) => {
        if (record.personalBest && (!biggestCatch || record.personalBest.weight > biggestCatch.weight)) {
            biggestCatch = {
                speciesId: id,
                weight: record.personalBest.weight,
                unit: fishSpecies[id]?.sizeRange.unit || 'lbs'
            };
        }
    });

    // Count total individual catches
    let totalCatches = 0;
    userCatchRecords.trips.forEach(trip => {
        totalCatches += trip.catches.length;
    });

    return {
        caughtSpecies: caughtFish.length,
        locationsVisited: visitedLocations.size,
        biggestCatch,
        totalCatches
    };
}

function updateHeaderStats() {
    const stats = calculateGlobalStats();
    document.getElementById('total-species').textContent = stats.caughtSpecies;
    document.getElementById('total-locations').textContent = stats.locationsVisited;
    document.getElementById('biggest-catch').textContent = stats.biggestCatch
        ? `${stats.biggestCatch.weight} ${stats.biggestCatch.unit}`
        : '-';
}

function initGlobe() {
    const container = document.getElementById('globe-container');
    const locationData = prepareLocationData();

    appState.globe = Globe()
        (container)
        .width(container.offsetWidth)
        .height(container.offsetHeight)

        // Globe appearance
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
        .showAtmosphere(true)
        .atmosphereColor('lightskyblue')
        .atmosphereAltitude(0.2)

        // Points (fishing locations)
        .pointsData(locationData)
        .pointLat(d => d.lat)
        .pointLng(d => d.lng)
        .pointAltitude(d => 0.02 + (Math.min(d.totalCatches, 10) / 10 * 0.03))
        .pointRadius(d => {
            // Increased base radius for easier clicking and hover detection
            const baseRadius = 0.7 + (Math.min(d.totalCatches, 10) / 10 * 0.5);
            // Enlarge dramatically when hovered
            if (appState.hoveredLocationId === d.id) {
                return baseRadius * 2.8;
            }
            return baseRadius;
        })
        .pointColor(d => getLocationColor(d.totalCatches))
        .pointLabel(d => buildLocationTooltip(d))
        .pointResolution(12)

        // Hover handler for markers
        .onPointHover((point, prevPoint) => {
            if (point) {
                appState.hoveredLocationId = point.id;
                // Change cursor to pointer when hovering over a point
                container.style.cursor = 'pointer';
            } else {
                appState.hoveredLocationId = null;
                // Reset cursor when not hovering
                container.style.cursor = 'grab';
            }
            // Trigger update to redraw points with new radius
            appState.globe.pointsData([...appState.globe.pointsData()]);
        })

        // Click handler for markers
        .onPointClick(handleLocationClick)

        // Initial view
        .pointOfView({ lat: 20, lng: 0, altitude: 2.5 });

    // Auto-rotation
    appState.globe.controls().autoRotate = false;
    appState.globe.controls().autoRotateSpeed = 0.4;
    appState.globe.controls().enableZoom = true;

    // Handle window resize
    window.addEventListener('resize', () => {
        appState.globe.width(container.offsetWidth);
        appState.globe.height(container.offsetHeight);
    });
}

function prepareLocationData() {
    return Object.values(fishingLocations).map(loc => {
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
            <div style="font-size: 12px; color: #a0a0c0; margin-bottom: 8px;">
                ${location.description}
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
        const fish = fishSpecies[catchItem.speciesId];
        const location = fishingLocations[catchItem.locationId];
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
                <span class="catch-weight">${catchItem.weight} ${fish.sizeRange.unit}</span>
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

    let fishList = Object.entries(fishSpecies);

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
    const records = calculatePersonalRecords();

    container.innerHTML = `
        <div class="records-section">
            <h4>Biggest Catches</h4>
            ${records.biggestCatches.length > 0 ? records.biggestCatches.map(r => {
                const fish = fishSpecies[r.speciesId];
                if (!fish) return '';
                const photoPath = getRepresentativePhotoForSpecies(r.speciesId);
                return `
                    <div class="record-item" data-fish-id="${r.speciesId}">
                        <span class="record-icon">
                            ${photoPath
                                ? `<img src="${photoPath}" alt="${fish.name}" class="record-photo" onerror="this.style.opacity='0';">`
                                : `<div class="fish-placeholder record-placeholder"></div>`
                            }
                        </span>
                        <span class="record-name">${fish.name}</span>
                        <span class="record-value">${r.weight} ${fish.sizeRange.unit}</span>
                    </div>
                `;
            }).join('') : '<p class="empty-state">No catches recorded</p>'}
        </div>

        <div class="records-section">
            <h4>Catches by Location</h4>
            ${Object.values(fishingLocations).map(loc => {
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

function calculatePersonalRecords() {
    // Get biggest catches by weight
    const biggestCatches = Object.entries(userCatchRecords.species)
        .filter(([id, record]) => record.caught && record.personalBest)
        .map(([id, record]) => ({
            speciesId: id,
            weight: record.personalBest.weight
        }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);

    return { biggestCatches };
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
            const location = fishingLocations[locationId];
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
}

function handleLocationClick(location) {
    appState.globe.controls().autoRotate = false;
    // Reset hover state after click
    appState.hoveredLocationId = null;
    appState.globe.pointsData([...appState.globe.pointsData()]);
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
    document.getElementById('location-description').textContent = location.description;
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
        const fish = fishSpecies[fishId];
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
                        const fish = fishSpecies[c.speciesId];
                        if (!fish) return '';
                        return `<span class="trip-fish">${fish.name} (${c.weight} ${fish.sizeRange.unit})</span>`;
                    }).join('')}
                </div>
                ${trip.notes ? `<p class="trip-notes">"${trip.notes}"</p>` : ''}
            </div>
        `;
    }).join('');
}

function showFishModal(fishId) {
    const fish = fishSpecies[fishId];
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
    document.getElementById('fish-description').textContent = isCaught
        ? fish.description
        : 'Catch this fish to learn more about it.';

    // Stats (always shown)
    document.getElementById('fish-size').textContent =
        `${fish.sizeRange.min} - ${fish.sizeRange.max} ${fish.sizeRange.unit}`;
    document.getElementById('fish-season').textContent =
        fish.bestSeason.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
    document.getElementById('fish-habitat').textContent = fish.habitat;

    // Personal records section
    const personalSection = document.getElementById('personal-catch-info');
    if (isCaught && userRecord) {
        personalSection.classList.remove('hidden');
        document.getElementById('first-catch-date').textContent = formatDate(userRecord.firstCatchDate);
        document.getElementById('times-caught').textContent = userRecord.totalCaught;
        document.getElementById('personal-best').textContent = userRecord.personalBest
            ? `${userRecord.personalBest.weight} ${fish.sizeRange.unit}`
            : 'N/A';
        document.getElementById('caught-location').textContent = userRecord.personalBest
            ? fishingLocations[userRecord.personalBest.locationId]?.name.split(',')[0] || 'Unknown'
            : 'N/A';
    } else {
        personalSection.classList.add('hidden');
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

function getImagePath(photoUrl) {
    return photoUrl ? `scrape/${photoUrl}` : null;
}

function getRepresentativePhotoForSpecies(speciesId) {
    const tripsWithSpecies = userCatchRecords.trips
        .filter(trip => trip.catches.some(c => c.speciesId === speciesId) && trip.photoUrl)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    return tripsWithSpecies[0] ? getImagePath(tripsWithSpecies[0].photoUrl) : null;
}

function getLocationCatchPhotos(locationId, limit = 4) {
    return userCatchRecords.trips
        .filter(trip => trip.locationId === locationId && trip.photoUrl)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, limit)
        .map(trip => getImagePath(trip.photoUrl));
}

// ============================================
// START APPLICATION
// ============================================
document.addEventListener('DOMContentLoaded', initApp);
