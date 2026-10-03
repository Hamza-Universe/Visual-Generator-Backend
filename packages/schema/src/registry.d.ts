export type JsonSchema = Record<string, unknown>;
export type RegistryComponent = {
    name: string;
    description: string;
    propsSchema: JsonSchema;
    defaultProps: Record<string, unknown>;
    enterStyles: string[];
    exitStyles: string[];
    colorProps: string[];
    refProps: string[];
    assetProps: string[];
};
