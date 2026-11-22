import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../whisper-custom.js', import.meta.url), 'utf8');

function setup(endpoint) {
    const calls = [];
    const list = { 0: {}, empty() {}, append() {} };
    const context = vm.createContext({
        SttBaseProvider: class {}, URL, FormData, console,
        window: { location: { origin: 'https://tavern.example' } },
        document: { getElementById: () => list[0] },
        $: selector => selector === '#custom_stt_models' ? list : { prop() {} },
        toastr: { info() {}, error() { assert.fail('Unexpected error toast'); } },
        fetch: async (url, options) => {
            calls.push({ url: url.href, options });
            return { ok: true, json: async () => ({ text: 'hello', data: [] }) };
        },
    });
    // Stub the browser-only base provider; exercise the actual custom provider.
    vm.runInContext(source.replace(/^import .*;\n/, '').replace('export class ', 'class ') + '\nglobalThis.provider = new CustomOpenAISttProvider();', context);
    const provider = context.provider;
    provider.settings = { url: endpoint, model: 'qwen3-asr', language: 'en' };
    provider.apiKey = 'test-key';
    return { provider, calls };
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
