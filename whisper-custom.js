import { SttBaseProvider } from './stt-base.js';

export class CustomOpenAISttProvider extends SttBaseProvider {
    constructor() {
        super();
        this.providerName = 'OpenAI Compatible';
        this.defaultSettings = { language: '', url: 'http://127.0.0.1:8080/v1/audio/transcriptions', model: 'qwen3-asr' };
        this.apiKey = '';
    }

    get settingsHtml() {
        return `
        <div class="flex-container flexFlowColumn">
            <label for="custom_stt_url">Transcription endpoint URL</label>
            <input id="custom_stt_url" class="text_pole" type="url" placeholder="http://127.0.0.1:8080/v1/audio/transcriptions">
            <label for="custom_stt_model">Model</label>
            <input id="custom_stt_model" class="text_pole" type="text" placeholder="qwen3-asr">
            <label for="custom_stt_key">API key (optional; cleared when switching providers or reloading)</label>
            <input id="custom_stt_key" class="text_pole" type="password" autocomplete="off">
            <small>The server must allow browser requests from SillyTavern's origin (CORS).</small>
        </div>`;
    }

    loadSettings(settings) {
        this.settings = { ...this.defaultSettings, ...settings };
        $('#speech_recognition_language').val(this.settings.language);
        $('#custom_stt_url').val(this.settings.url);
        $('#custom_stt_model').val(this.settings.model);
        $('#custom_stt_key').val(this.apiKey);
    }

    onSettingsChange() {
        this.settings.url = String($('#custom_stt_url').val()).trim();
        this.settings.model = String($('#custom_stt_model').val()).trim();
        this.apiKey = String($('#custom_stt_key').val());
    }

    async processAudio(audioBlob) {
        const url = new URL(this.settings.url);
        if (!['http:', 'https:'].includes(url.protocol) || !this.settings.model) {
            throw new Error('A valid HTTP(S) transcription URL and model are required');
        }

        const form = new FormData();
        form.append('file', audioBlob, 'record.wav');
        form.append('model', this.settings.model);
        if (this.settings.language) form.append('language', this.settings.language);

        const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
        const response = await fetch(url, { method: 'POST', headers, body: form });
        if (!response.ok) {
            const error = await response.text();
            toastr.error(response.statusText, 'STT Generation Failed (OpenAI Compatible)');
            throw new Error(`HTTP ${response.status}: ${error}`);
        }
        const result = await response.json();
        if (typeof result.text !== 'string') throw new Error('Transcription response is missing text');
        return result.text;
    }
}
