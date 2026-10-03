import type { RegistryComponent } from './registry.js';
import type { VideoSpec } from './spec.js';
export type Issue = {
    path: string;
    code: string;
    message: string;
};
export type ValidationContext = {
    registry: Map<string, RegistryComponent>;
    assetExists: (id: string) => boolean;
    assetKind: (id: string) => string | undefined;
    maxComponents?: number;
};
export declare const validateSpec: (spec: VideoSpec, ctx: ValidationContext) => Issue[];
