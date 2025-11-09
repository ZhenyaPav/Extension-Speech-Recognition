export { WhisperCppSttProvider };

const DEBUG_PREFIX = '<Speech Recognition module (Whisper.cpp)> ';

class WhisperCppSttProvider {
    settings;

    defaultSettings = {
        language: '',
        endpoint: 'http://127.0.0.1:8080/inference',
        temperature: '0.0',
        temperature_inc: '0.2',
        response_format: 'json',
    };

    get settingsHtml() {
        return `
        <div class="flex-container flexFlowColumn" style="margin-top:8px">
            <label for="whisper_cpp_endpoint">Server Endpoint</label>
            <input id="whisper_cpp_endpoint" type="text" class="text_pole" placeholder="http://127.0.0.1:8080/inference">
            
            <label for="whisper_cpp_temperature" style="margin-top:8px">Temperature</label>
            <input id="whisper_cpp_temperature" type="text" class="text_pole" placeholder="0.0">
            
            <label for="whisper_cpp_temperature_inc" style="margin-top:8px">Temperature Increment</label>
            <input id="whisper_cpp_temperature_inc" type="text" class="text_pole" placeholder="0.2">
            
            <label for="whisper_cpp_response_format" style="margin-top:8px">Response Format</label>
            <select id="whisper_cpp_response_format">
                <option value="json">JSON</option>
                <option value="text">Text</option>
                <option value="srt">SRT</option>
                <option value="verbose_json">Verbose JSON</option>
                <option value="vtt">VTT</option>
            </select>
        </div>
        `;
    }

    onSettingsChange() {
        // Used when provider settings are updated from UI
        this.settings.endpoint = String($('#whisper_cpp_endpoint').val());
        this.settings.temperature = String($('#whisper_cpp_temperature').val());
        this.settings.temperature_inc = String($('#whisper_cpp_temperature_inc').val());
        this.settings.response_format = String($('#whisper_cpp_response_format').val());
    }

    loadSettings(settings) {
        // Populate Provider UI given input settings
        if (Object.keys(settings).length == 0) {
            console.debug(DEBUG_PREFIX + 'Using default Whisper.cpp STT extension settings');
        }

        // Only accept keys defined in defaultSettings
        this.settings = { ...this.defaultSettings };
        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            } else {
                throw `Invalid setting passed to STT extension: ${key}`;
            }
        }

        $('#speech_recognition_language').val(this.settings.language);
        $('#whisper_cpp_endpoint').val(this.settings.endpoint);
        $('#whisper_cpp_temperature').val(this.settings.temperature);
        $('#whisper_cpp_temperature_inc').val(this.settings.temperature_inc);
        $('#whisper_cpp_response_format').val(this.settings.response_format);
        console.debug(DEBUG_PREFIX + 'Whisper.cpp STT settings loaded', this.settings);
    }

    async processAudio(audioBlob) {
        const requestData = new FormData();
        requestData.append('file', audioBlob, 'audio.wav');
        requestData.append('temperature', this.settings.temperature || this.defaultSettings.temperature);
        requestData.append('temperature_inc', this.settings.temperature_inc || this.defaultSettings.temperature_inc);
        requestData.append('response_format', this.settings.response_format || this.defaultSettings.response_format);

        if (this.settings.language) {
            requestData.append('language', this.settings.language);
        }

        console.debug(DEBUG_PREFIX + 'Sending request to:', this.settings.endpoint);
        console.debug(DEBUG_PREFIX + 'Request params:', {
            temperature: this.settings.temperature,
            temperature_inc: this.settings.temperature_inc,
            response_format: this.settings.response_format,
            language: this.settings.language || 'auto'
        });

        try {
            const apiResult = await fetch(this.settings.endpoint, {
                method: 'POST',
                body: requestData,
            });

            if (!apiResult.ok) {
                const errorText = await apiResult.text();
                toastr.error(`${apiResult.status}: ${errorText}`, 'STT Generation Failed (Whisper.cpp)', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
                throw new Error(`HTTP ${apiResult.status}: ${errorText}`);
            }

            const result = await apiResult.json();
            
            // Handle different response formats
            if (this.settings.response_format === 'json' || this.settings.response_format === 'verbose_json') {
                return result.text || result.transcription || '';
            } else if (this.settings.response_format === 'text') {
                return result;
            } else {
                // For SRT, VTT formats, return the raw response
                return result;
            }
        } catch (error) {
            console.error(DEBUG_PREFIX + 'Error processing audio:', error);
            toastr.error(error.message, 'STT Generation Failed (Whisper.cpp)', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
            throw error;
        }
    }
}
