export interface ModelCacheFile {
    version?: number;
    binary: string;
    fetchedAt: number;
    models: Record<string, DiscoveredAgyModel>;
}
export interface DiscoveredAgyModel {
    name: string;
    options?: {
        effort?: string;
    };
    variants?: Record<string, {}>;
}
export declare function parseAgyModels(output: string): Record<string, DiscoveredAgyModel>;
export declare function isModelCacheFresh(cache: ModelCacheFile | null, now: number, ttlMs?: number): boolean;
export declare function saveModelCache(path: string, cache: ModelCacheFile): Promise<void>;
export declare function applyAgyModels(cfg: {
    provider?: Record<string, any>;
}, opts?: {
    cacheFile?: string;
    list?: (binary: string) => Promise<Record<string, DiscoveredAgyModel>>;
    now?: number;
    ttlMs?: number;
    waitRefresh?: boolean;
}): Promise<void>;
