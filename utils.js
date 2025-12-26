import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// API configuration with fallback order
// Only fetching IP address and country code to keep it lightweight
const API_ENDPOINTS = [
    {
        name: 'ip-api.com',
        url: 'http://ip-api.com/json?fields=query,countryCode',
        fieldMap: {
            ip: 'query',
            countryCode: 'countryCode',
        },
    },
    {
        name: 'api.my-ip.io',
        url: 'https://api.my-ip.io/v2/ip.json',
        fieldMap: {
            ip: 'ip',
            countryCode: 'country.code',
        },
    },
    {
        name: 'ifconfig.co',
        url: 'https://ifconfig.co/json',
        fieldMap: {
            ip: 'ip',
            countryCode: 'country_iso',
        },
    },
];

/**
 * Get nested property value from object using dot notation
 * @param {object} obj - The object to search
 * @param {string} path - The path in dot notation (e.g., 'country.code')
 * @returns {any} The value or undefined
 */
function getNestedValue(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((current, prop) => current?.[prop], obj);
}

/**
 * Normalize API response to standard format
 * @param {object} rawData - Raw API response
 * @param {object} fieldMap - Field mapping configuration
 * @returns {object} Normalized data object
 */
function normalizeApiResponse(rawData, fieldMap) {
    const normalized = {};

    for (const [standardKey, apiKey] of Object.entries(fieldMap)) {
        if (apiKey === null) {
            normalized[standardKey] = null;
        } else {
            const value = getNestedValue(rawData, apiKey);
            normalized[standardKey] = value !== undefined ? value : null;
        }
    }

    return normalized;
}

/**
 * Fetch IP details with fallback to multiple API sources
 * Only fetches IP address and country code to minimize data transfer
 * @param {Soup.Session} session
 * @returns {{data: object | null, error: string | null, apiUsed: string | null}} object containing the data of the IP details or error message on fail
 */
export async function getIPDetails(session) {
    const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    let lastError = null;

    // Try each API in sequence
    for (const api of API_ENDPOINTS) {
        try {
            console.log(`IP-Finder: Trying ${api.name}...`);

            const message = Soup.Message.new('GET', api.url);
            message.request_headers.append('User-Agent', USER_AGENT);

            const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

            // Check HTTP status code
            if (message.status_code !== 200) {
                console.log(`IP-Finder: ${api.name} returned status code ${message.status_code}, trying next API...`);
                lastError = `${api.name} returned status ${message.status_code}`;
                continue;
            }

            // Parse response
            const decoder = new TextDecoder('utf-8');
            const rawData = JSON.parse(decoder.decode(bytes.get_data()));

            // Normalize the response
            const normalizedData = normalizeApiResponse(rawData, api.fieldMap);

            console.log(`IP-Finder: Successfully fetched data from ${api.name}`);
            return {data: normalizedData, apiUsed: api.name};

        } catch (e) {
            console.log(`IP-Finder: Error with ${api.name}: ${e}`);
            lastError = `${api.name}: ${e.message || e}`;
            continue;
        }
    }

    // All APIs failed
    console.log('IP-Finder: All API sources exhausted');
    return {error: lastError || 'All API sources failed'};
}
