// src/__tests__/aiBackend.test.ts
// Unit tests for the AI backend abstraction (callAI dispatcher + individual backends).
// vscode and fetch are mocked so these tests run in Node without a VS Code host.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock vscode module
// ---------------------------------------------------------------------------
const mockGetConfig = vi.fn(() => 'copilot');

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: mockGetConfig,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock global fetch (used by OpenAI and Anthropic backends)
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

// Mock TextDecoder for SSE parsing
vi.mock('util', () => ({
  TextDecoder: class {
    decode(_value: Uint8Array, opts?: { stream?: boolean }): string {
      return '';
    }
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { callAI } from '../aiBackend';
import type { AIKeys } from '../aiBackend';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYS: AIKeys = {
  openai: 'sk-openai-test-key',
  anthropic: 'sk-ant-test-key',
};

function makeTextPart(value: string) {
  return { value };
}

function makeCopilotModel(name = 'gpt-4o', id = 'copilot-1') {
  return {
    name,
    id,
    vendor: 'copilot',
    sendRequest: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('callAI — dispatcher', () => {
  beforeEach(() => {
    mockGetConfig.mockReset();
    mockFetch.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Copilot backend (default)', () => {
    it('calls Copilot when aiBackend is set to copilot', async () => {
      mockGetConfig.mockReturnValue('copilot');

      const mockModel = makeCopilotModel();
      const mockTextParts = [
        makeTextPart('Hello '),
        makeTextPart('world'),
      ];
      mockModel.sendRequest.mockResolvedValue({
        text: (async function* () {
          for (const part of mockTextParts) {
            yield part.value;
          }
        })(),
      });

      const mockSelectModels = vi.fn().mockResolvedValue([mockModel]);
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
        lm: { selectChatModels: mockSelectModels },
        LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
        CancellationTokenSource: class { token = {}; },
      }));

      // Re-import after mocking
      const { callAI: callAIDynamic } = await import('../aiBackend');

      const result = await callAIDynamic('test prompt', 'test system', {});

      expect(result.backend).toBe('GitHub Copilot');
      expect(result.text).toBe('Hello world');
    });

    it('throws when no Copilot models are available', async () => {
      mockGetConfig.mockReturnValue('copilot');

      const mockSelectModels = vi.fn().mockResolvedValue([]);
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
        lm: { selectChatModels: mockSelectModels },
        LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
        CancellationTokenSource: class { token = {}; },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');

      await expect(callAIDynamic('prompt', 'system', {})).rejects.toThrow('No Copilot models available');
    });
  });

  describe('OpenAI backend', () => {
    it('calls OpenAI when aiBackend is set to openai and key is provided', async () => {
      mockGetConfig.mockReturnValue('openai');

      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'OpenAI response' } }],
            model: 'gpt-4o',
          }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      // Re-import with fresh mocks
      vi.resetModules();
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');
      const result = await callAIDynamic('test prompt', 'test system', KEYS);

      expect(result.backend).toBe('OpenAI');
      expect(result.text).toBe('OpenAI response');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-openai-test-key',
          }),
        })
      );
    });

    it('falls back to Copilot when OpenAI returns an error', async () => {
      mockGetConfig.mockReturnValue('openai');

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Invalid API key'),
      });

      // No Copilot available in this test — expect all backends to fail
      vi.resetModules();
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
        lm: { selectChatModels: vi.fn().mockResolvedValue([]) },
        LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
        CancellationTokenSource: class { token = {}; },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');

      await expect(callAIDynamic('prompt', 'system', KEYS)).rejects.toThrow('All AI backends failed');
    });
  });

  describe('Anthropic backend', () => {
    it('calls Anthropic when aiBackend is set to anthropic and key is provided', async () => {
      mockGetConfig.mockReturnValue('anthropic');

      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: 'text', text: 'Anthropic response' }],
            model: 'claude-sonnet-4-20250514',
          }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      vi.resetModules();
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');
      const result = await callAIDynamic('test prompt', 'test system', KEYS);

      expect(result.backend).toBe('Anthropic');
      expect(result.text).toBe('Anthropic response');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test-key',
            'anthropic-version': '2023-06-01',
          }),
        })
      );
    });

    it('falls back to Copilot when Anthropic returns an error', async () => {
      mockGetConfig.mockReturnValue('anthropic');

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Invalid API key'),
      });

      vi.resetModules();
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
        lm: { selectChatModels: vi.fn().mockResolvedValue([]) },
        LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
        CancellationTokenSource: class { token = {}; },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');

      await expect(callAIDynamic('prompt', 'system', KEYS)).rejects.toThrow('All AI backends failed');
    });
  });

  describe('Fallback chain', () => {
    it('tries Copilot as fallback when selected backend is not copilot', async () => {
      mockGetConfig.mockReturnValue('openai');

      // OpenAI fails
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });

      // Copilot succeeds
      const mockModel = makeCopilotModel();
      mockModel.sendRequest.mockResolvedValue({
        text: (async function* () {
          yield 'Fallback works';
        })(),
      });

      vi.resetModules();
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
        lm: { selectChatModels: vi.fn().mockResolvedValue([mockModel]) },
        LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
        CancellationTokenSource: class { token = {}; },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');
      const result = await callAIDynamic('prompt', 'system', KEYS);

      expect(result.text).toBe('Fallback works');
      expect(result.backend).toBe('GitHub Copilot');
    });
  });

  describe('All backends failed', () => {
    it('throws a descriptive error when all backends fail', async () => {
      mockGetConfig.mockReturnValue('openai');

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('All errors'),
      });

      vi.resetModules();
      vi.doMock('vscode', () => ({
        workspace: { getConfiguration: () => ({ get: mockGetConfig }) },
        lm: { selectChatModels: vi.fn().mockResolvedValue([]) },
        LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', content: text }) },
        CancellationTokenSource: class { token = {}; },
      }));

      const { callAI: callAIDynamic } = await import('../aiBackend');

      await expect(callAIDynamic('prompt', 'system', KEYS)).rejects.toThrow(
        'All AI backends failed'
      );
    });
  });
});
