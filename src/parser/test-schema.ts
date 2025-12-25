export interface TestDefinition {
    name: string;
    workflow: string; // Name or path
    fixture: {
        inputs?: Record<string, unknown>;
        env?: Record<string, string>;
        secrets?: Record<string, string>;
        mocks?: Array<{
            step?: string;
            type?: string;
            prompt?: string;
            response: any;
        }>;
    };
    snapshot?: {
        steps: Record<string, {
            status: string;
            output: any;
            error?: string;
        }>;
        outputs: Record<string, any>;
    };
}
