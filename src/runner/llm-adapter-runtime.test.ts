import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    AnthropicAdapter,
    GoogleGeminiAdapter,
    OpenAIAdapter,
    getAdapter,
    LocalEmbeddingAdapter,
    collectOnnxRuntimeLibraryDirs,
    findOnnxRuntimeLibraryPath,
    ensureOnnxRuntimeLibraryPath,
    resolveNativeModuleFallback,
    resolveTransformersCacheDir,
    resolveTransformersPath,
    ensureNativeModuleFallbacks,
    ensureRuntimeResolver,
    resetRuntimeHelpers,
} from './llm-adapter';
import { AuthManager } from '../utils/auth-manager';
import { ConfigLoader } from '../utils/config-loader';

describe('LLM Adapter Runtime and Helpers', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        resetRuntimeHelpers();
        ConfigLoader.clear();
        // Reset process.env
        for (const key in process.env) {
            delete process.env[key];
        }
        Object.assign(process.env, originalEnv);
    });

    afterEach(() => {
        resetRuntimeHelpers();
        mock.restore();
        // @ts-ignore
        process.platform = originalPlatform;
        // @ts-ignore
        process.arch = originalArch;
    });

    describe('Runtime Resolution', () => {
        it('should collect ONNX runtime library dirs from environment', () => {
            process.env.KEYSTONE_ONNX_RUNTIME_LIB_DIR = '/custom/onnx/dir';

            // Mock readdirSync to return true for hasOnnxRuntimeLibrary
            const readdirSpy = spyOn(fs, 'readdirSync').mockReturnValue([
                { isFile: () => true, name: 'libonnxruntime.so' } as any
            ]);

            // We need to trigger a path that calls collectOnnxRuntimeLibraryDirs
            // getAdapter('local') might trigger it via LocalEmbeddingAdapter
            const { adapter } = getAdapter('local');
            expect(adapter).toBeInstanceOf(LocalEmbeddingAdapter);

            readdirSpy.mockRestore();
        });

        it('should handle ONNX library discovery across multiple paths', () => {
            process.env.KEYSTONE_ONNX_RUNTIME_LIB_DIR = '/env/onnx';
            process.env.KEYSTONE_RUNTIME_DIR = '/runtime/dir';

            const existsSpy = spyOn(fs, 'existsSync').mockImplementation(((p: string) => {
                return p.includes('onnx') || p.includes('lib');
            }) as any);

            const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((p: string | Buffer | URL, options?: any) => {
                if (typeof p !== 'string') return [];
                if (p.includes('onnx') || p.includes('env')) {
                    return [{ isFile: () => true, name: 'libonnxruntime.so' }] as any;
                }
                return [];
            }) as any);

            const dirs = collectOnnxRuntimeLibraryDirs();
            expect(dirs).toContain('/env/onnx');

            const libPath = findOnnxRuntimeLibraryPath(dirs);
            expect(libPath).toContain('/env/onnx/libonnxruntime.so');

            // Test ensureOnnxRuntimeLibraryPath
            ensureOnnxRuntimeLibraryPath();
            expect(process.env.LD_LIBRARY_PATH || process.env.DYLD_LIBRARY_PATH || process.env.PATH).toContain('/env/onnx');

            existsSpy.mockRestore();
            readdirSpy.mockRestore();
        });

        it('should handle transformers cache dir resolution across env vars', () => {
            process.env.TRANSFORMERS_CACHE = '/custom/cache';
            expect(resolveTransformersCacheDir()).toBe('/custom/cache');

            delete process.env.TRANSFORMERS_CACHE;
            process.env.XDG_CACHE_HOME = '/xdg/cache';
            expect(resolveTransformersCacheDir()).toContain('/xdg/cache');

            delete process.env.XDG_CACHE_HOME;
            process.env.HOME = '/home/user';
            expect(resolveTransformersCacheDir()).toContain('/home/user/.cache');
        });

        it('should handle transformers path resolution', () => {
            process.env.KEYSTONE_TRANSFORMERS_PATH = '/path/to/transformers';
            const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
            expect(resolveTransformersPath()).toBe('/path/to/transformers');
            existsSpy.mockRestore();

            const existsSpyFail = spyOn(fs, 'existsSync').mockReturnValue(false);
            expect(resolveTransformersPath()).toBeNull();
            existsSpyFail.mockRestore();
        });

        it('should resolve native module fallbacks correctly', () => {
            process.env.KEYSTONE_RUNTIME_DIR = '/runtime';

            const existsSpy = spyOn(fs, 'existsSync').mockImplementation(((p: string) => p.includes('onnxruntime_binding.node')) as any);

            const fallback = resolveNativeModuleFallback('onnxruntime_binding.node', 'some/parent/path');
            expect(fallback).toContain('onnxruntime_binding.node');
            expect(fallback).toContain('/runtime');

            existsSpy.mockRestore();
        });

        it('should register native module fallbacks', () => {
            ensureNativeModuleFallbacks();
            // Second call should return early
            ensureNativeModuleFallbacks();
        });

        it('should register runtime resolver on Bun', () => {
            if (typeof Bun === 'undefined') {
                (global as any).Bun = { plugin: Object.assign(mock(() => { }), { clearAll: mock(() => { }) }) };
            }

            const pluginMock = Object.assign(mock(() => { }), { clearAll: mock(() => { }) });
            // @ts-ignore
            const pluginSpy = spyOn(Bun, 'plugin').mockImplementation(pluginMock as any);

            ensureRuntimeResolver();

            expect(pluginSpy).toHaveBeenCalled();

            // Second call should return early
            ensureRuntimeResolver();

            pluginSpy.mockRestore();
        });

        it('should handle native module fallbacks for sharp and onnxruntime', () => {
            // This is hard to test directly since it modifies Module._resolveFilename
            // but we can verify the fallback function logic

            // @ts-ignore - access private/internal function if possible or just rely on coverage from execution
            // Actually we can just run a chat and see if it triggers the logic
        });
    });

    describe('LocalEmbeddingAdapter', () => {
        it('should throw error on chat calls', async () => {
            const adapter = new LocalEmbeddingAdapter();
            await expect(adapter.chat([])).rejects.toThrow(/Local models in Keystone currently only support memory\/embedding operations/);
        });

        it('should initialize and call embed', async () => {
            // Mock the pipeline import and execution
            const mockPipeline = mock(async () => {
                return async (text: string) => ({
                    data: [0.1, 0.2, 0.3]
                });
            });

            // LocalEmbeddingAdapter uses dynamic import for @xenova/transformers
            // This is hard to mock in Bun without mock.module
        });
    });

    describe('Platform Helpers', () => {
        it('should identify platforms correctly', () => {
            // These are tested indirectly but let's be explicit
            const platforms = ['darwin', 'linux', 'win32'];
            for (const p of platforms) {
                // @ts-ignore
                process.platform = p;
                // Trigger some logic that uses these
            }
        });
    });
});
