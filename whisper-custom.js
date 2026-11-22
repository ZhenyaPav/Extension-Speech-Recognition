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
            <input id="custom_stt_model" class="text_pole" type="text" list="custom_stt_models" placeholder="qwen3-asr">
            <datalist id="custom_stt_models"></datalist>
            <button type="button" id="custom_stt_refresh_models" class="menu_button">Load models</button>
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
        $('#custom_stt_refresh_models').off('click').on('click', () => this.loadModels());
    }

    onSettingsChange() {
        const url = String($('#custom_stt_url').val()).trim();
        if (url !== this.settings.url) $('#custom_stt_models').empty();
        this.settings.url = url;
        this.settings.model = String($('#custom_stt_model').val()).trim();
        this.apiKey = String($('#custom_stt_key').val());
    }

    async loadModels() {
        const button = $('#custom_stt_refresh_models');
        const list = $('#custom_stt_models');
        const endpoint = this.settings.url;
        button.prop('disabled', true);
        try {
            const url = new URL(endpoint);
            if (!['http:', 'https:'].includes(url.protocol) || !/\/audio\/transcriptions\/?$/.test(url.pathname)) {
                throw new Error('The transcription URL must end in /audio/transcriptions');
            }
            url.pathname = url.pathname.replace(/\/audio\/transcriptions\/?$/, '/models');
            url.search = '';
            url.hash = '';
            const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
            const response = await fetch(url, { headers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            if (!Array.isArray(result.data)) throw new Error('Invalid model list response');
            if (endpoint !== this.settings.url || list[0] !== document.getElementById('custom_stt_models')) return;
            list.empty();
            for (const model of result.data) {
                if (typeof model?.id === 'string' && model.id) {
                    list.append($('<option>').val(model.id));
                }
            }
            toastr.info('Select a model from the Model field, or enter one manually.', 'Models loaded');
        } catch (error) {
            console.error('Could not load transcription models', error);
            toastr.error('Check the endpoint, API key, and server CORS settings. You can still enter a model manually.', 'Could not load models');
        } finally {
            button.prop('disabled', false);
        }
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
