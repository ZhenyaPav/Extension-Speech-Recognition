import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../whisper-custom.js', import.meta.url), 'utf8');

function setup(endpoint, models = []) {
    const calls = [];
    const elements = new Map();
    function element() {
        return {
            0: {}, value: '', options: [], handlers: {},
            val(value) {
                if (arguments.length === 0) return this.value;
                this.value = this === list && !this.options.some(option => option.value === value) ? null : value;
                return this;
            },
            text(value) { this.label = value; return this; },
            append(option) { this.options.push(option); return this; },
            find() { return { remove: () => { this.options.splice(1); } }; },
            prop() {},
            off(event) { delete this.handlers[event]; return this; },
            on(event, handler) { this.handlers[event] = handler; return this; },
        };
    }
    const list = element();
    list.options.push({ value: '', label: 'Select a loaded model' });
    elements.set('#custom_stt_models', list);
    function $(selector) {
        if (selector === '<option>') return element();
        if (selector === '#custom_stt_models option:not(:first)') return list.find();
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
    }
    const context = vm.createContext({
        SttBaseProvider: class {}, URL, FormData, console,
        window: { location: { origin: 'https://tavern.example' } },
        document: { getElementById: () => list[0] },
        $,
        toastr: { info() {}, error() { assert.fail('Unexpected error toast'); } },
        fetch: async (url, options) => {
            calls.push({ url: url.href, options });
            return { ok: true, json: async () => ({ text: 'hello', data: models }) };
        },
    });
    // Stub the browser-only base provider; exercise the actual custom provider.
    vm.runInContext(source.replace(/^import .*;\n/, '').replace('export class ', 'class ') + '\nglobalThis.provider = new CustomOpenAISttProvider();', context);
    const provider = context.provider;
    provider.settings = { url: endpoint, model: 'qwen3-asr', language: 'en' };
    provider.apiKey = 'test-key';
    return { provider, calls, $, list };
}

for (const endpoint of [
    '/proxy/http://192.168.31.24:8086/v1/audio/transcriptions',
    'http://192.168.31.24:8086/v1/audio/transcriptions',
]) {
    test(`transcription and model discovery: ${endpoint}`, async () => {
        const { provider, calls } = setup(endpoint);
        const audio = new Blob(['audio'], { type: 'audio/wav' });
        assert.equal(await provider.processAudio(audio), 'hello');
        assert.equal(calls[0].url, new URL(endpoint, 'https://tavern.example').href);
        assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
        assert.equal(calls[0].options.body.get('model'), 'qwen3-asr');
        assert.equal(calls[0].options.body.get('language'), 'en');
        assert.equal(await calls[0].options.body.get('file').text(), 'audio');

        await provider.loadModels();
        assert.equal(calls[1].url, calls[0].url.replace('/audio/transcriptions', '/models'));
        assert.equal(calls[1].options.headers.Authorization, 'Bearer test-key');
    });
}

test('rejects non-HTTP transcription URLs before fetching', async () => {
    const { provider, calls } = setup('file:///audio/transcriptions');
    await assert.rejects(provider.processAudio(new Blob()), /valid HTTP\(S\)/);
    assert.equal(calls.length, 0);
});

test('loads labeled dropdown options and saves a selected model', async () => {
    const { provider, $, list } = setup('http://server/v1/audio/transcriptions', [
        { id: 'qwen3-asr' }, { id: 'whisper-1' }, { id: '' }, { id: 123 },
    ]);
    provider.loadSettings(provider.settings);
    await provider.loadModels();
    assert.deepEqual(list.options.map(option => [option.value, option.label]), [
        ['', 'Select a loaded model'], ['qwen3-asr', 'qwen3-asr'], ['whisper-1', 'whisper-1'],
    ]);
    assert.equal(list.val(), 'qwen3-asr');
    list.val('whisper-1');
    list.handlers.input();
    // The extension's delegated input handler runs after the select's handler.
    provider.onSettingsChange();
    assert.equal($('#custom_stt_model').val(), 'whisper-1');
    assert.equal(provider.settings.model, 'whisper-1');
});

test('preserves manual model IDs and clears choices when the endpoint changes', async () => {
    const { provider, $, list } = setup('http://server/v1/audio/transcriptions', [{ id: 'qwen3-asr' }]);
    provider.loadSettings(provider.settings);
    await provider.loadModels();
    $('#custom_stt_model').val('custom-model');
    provider.onSettingsChange();
    assert.equal(provider.settings.model, 'custom-model');
    assert.equal(list.val(), '');
    $('#custom_stt_url').val('http://other/v1/audio/transcriptions');
    provider.onSettingsChange();
    assert.equal(list.options.length, 1);
    assert.equal(provider.settings.model, 'custom-model');
});
