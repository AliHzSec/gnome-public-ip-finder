import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

// Cloudflare whoami DNS query configuration
const DNS_SERVER = 'alex.ns.cloudflare.com';
const QUERY_NAME = 'whoami.cloudflare.net';
const QUERY_TYPE = 'TXT';

// dig's own per-query timeout in seconds (see +time) and retry count (+tries)
const DIG_TIMEOUT = 3;
const DIG_TRIES = 1;

/**
 * Check whether the dig binary is available on the system
 * @returns {string | null} Full path to dig or null when missing
 */
function findDig() {
    return GLib.find_program_in_path('dig');
}

/**
 * Run the dig TXT query against Cloudflare's whoami service
 * @param {string} digPath - Full path to the dig binary
 * @returns {Promise<string>} Raw stdout of the dig command
 */
async function runDigQuery(digPath) {
    const proc = new Gio.Subprocess({
        argv: [
            digPath,
            `@${DNS_SERVER}`,
            QUERY_NAME,
            QUERY_TYPE,
            '+short',
            `+time=${DIG_TIMEOUT}`,
            `+tries=${DIG_TRIES}`,
        ],
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    proc.init(null);

    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);

    if (!proc.get_successful()) {
        // dig reports query errors (e.g. timeouts) on stdout as ';'-prefixed lines
        const detail = (stderr || '').trim() ||
            (stdout || '').split('\n').find(line => line.startsWith(';;'))?.replace(/^;;\s*/, '') ||
            `dig exited with status ${proc.get_exit_status()}`;
        throw new Error(shortenDigError(detail));
    }

    return stdout;
}

/**
 * Shorten verbose dig error messages so they fit in the panel
 * @param {string} detail - Raw dig error message
 * @returns {string} Shortened error message
 */
function shortenDigError(detail) {
    if (/timed out/i.test(detail))
        return 'DNS request timed out';
    if (/no servers could be reached/i.test(detail))
        return 'No DNS server reachable';
    if (/network is unreachable/i.test(detail))
        return 'Network unreachable';
    return detail;
}

/**
 * Parse dig +short output of the whoami.cloudflare.net TXT records
 * Expected lines look like: "remote_ip: 203.0.113.10" and "country_code: DE"
 * @param {string} output - Raw dig stdout
 * @returns {{ip: string, countryCode: string | null}} Parsed IP details
 */
function parseWhoamiOutput(output) {
    const ipMatch = output.match(/remote_ip:\s*([0-9a-fA-F.:]+)/);
    const countryMatch = output.match(/country_code:\s*([A-Za-z]{2})/);

    if (!ipMatch)
        throw new Error('Unexpected DNS response');

    return {
        ip: ipMatch[1],
        countryCode: countryMatch ? countryMatch[1].toUpperCase() : null,
    };
}

/**
 * Fetch public IP details using a DNS TXT query to Cloudflare's whoami service
 * @returns {Promise<{data: object | null, error: string | null}>} Object containing the IP details or an error message on failure
 */
export async function getIPDetails() {
    try {
        const digPath = findDig();
        if (!digPath)
            return { data: null, error: 'dig not found' };

        const output = await runDigQuery(digPath);
        const data = parseWhoamiOutput(output);

        return { data, error: null };
    } catch (e) {
        console.log(`IP-Finder: DNS query error: ${e.message || e}`);
        return { data: null, error: e.message || 'DNS query failed' };
    }
}
