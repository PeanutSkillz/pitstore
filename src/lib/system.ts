// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Compact system summary for the Dashboard. Values come from /proc and from
// df with a fixed argv; the parsers are pure functions.

export interface CpuSample { busy: number; total: number }

export function parseProcStat(text: string): CpuSample {
    const line = text.split('\n').find(l => l.startsWith('cpu '));
    if (!line)
        throw new Error("no cpu line in /proc/stat");
    const v = line.trim().split(/\s+/)
            .slice(1)
            .map(Number);
    // user nice system idle iowait irq softirq steal
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    const total = v.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return { busy: total - idle, total };
}

export function cpuPercent(a: CpuSample, b: CpuSample): number {
    const total = b.total - a.total;
    return total > 0 ? Math.min(100, Math.max(0, ((b.busy - a.busy) / total) * 100)) : 0;
}

export function parseMeminfo(text: string): { total: number; used: number } {
    const kb = (key: string) => {
        const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
        return m ? Number(m[1]) * 1024 : 0;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    return { total, used: Math.max(0, total - available) };
}

/* Output of: df -B1 --output=size,used,target / */
export function parseDf(text: string): { size: number; used: number; mount: string } {
    const line = text.trim().split('\n')[1];
    if (!line)
        throw new Error("unexpected df output");
    const [size, used, mount] = line.trim().split(/\s+/);
    return { size: Number(size), used: Number(used), mount };
}

export function parseUptime(text: string): number {
    return Math.floor(Number(text.trim().split(/\s+/)[0]) || 0);
}

export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
