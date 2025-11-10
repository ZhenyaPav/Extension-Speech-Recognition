/*
TODO:
 - try pseudo streaming audio by just sending chunk every X seconds and asking VOSK if it is full text.
*/

import { saveSettingsDebounced, sendMessageAsUser } from '../../../../script.js';
import { getContext, extension_settings, ModuleWorkerWrapper } from '../../../extensions.js';
import { VoskSttProvider } from './vosk.js';
import { WhisperExtrasSttProvider } from './whisper-extras.js';
import { OpenAISttProvider } from './whisper-openai.js';
import { WhisperLocalSttProvider } from './whisper-local.js';
import { WhisperCppSttProvider } from './whisper-cpp.js';
import { BrowserSttProvider } from './browser.js';
import { StreamingSttProvider } from './streaming.js';
import { KoboldCppSttProvider } from './koboldcpp.js';
import { VAD } from './vad.js'
export { MODULE_NAME };
export { activateMicIcon, deactivateMicIcon };

const MODULE_NAME = 'Speech Recognition';
const DEBUG_PREFIX = '<Speech Recognition module> ';
const UPDATE_INTERVAL = 100;

let inApiCall = false;

let sttProviders = {
    None: null,
    Browser: BrowserSttProvider,
    'KoboldCpp': KoboldCppSttProvider,
    'Whisper (Extras)': WhisperExtrasSttProvider,
    'OpenAI': OpenAISttProvider,
    'Whisper (Local)': WhisperLocalSttProvider,
    'Whisper (cpp)': WhisperCppSttProvider,
    Vosk: VoskSttProvider,
    Streaming: StreamingSttProvider,
};

let sttProvider = null;
let sttProviderName = 'None';

let audioRecording = false;
const constraints = { audio: { sampleSize: 16, channelCount: 1, sampleRate: 16000 } };
let audioChunks = [];

/** @type {MediaRecorder} */
let mediaRecorder = null;

// VAD System
let vadInstance = null;
let audioContext = null;
let mediaStream = null;

async function moduleWorker() {
    if (sttProviderName != 'Streaming') {
        return;
    }

    // API is busy
    if (inApiCall) {
        return;
    }

    try {
        inApiCall = true;
        const userMessageOriginal = await sttProvider.getUserMessage();
        let userMessageFormatted = userMessageOriginal.trim();

        if (userMessageFormatted.length > 0) {
            console.debug(DEBUG_PREFIX + 'recorded transcript: "' + userMessageFormatted + '"');

            let userMessageLower = userMessageFormatted.toLowerCase();
            // remove punctuation
            let userMessageRaw = userMessageLower.replace(/[^\p{L}\p{M}\s']/gu, '').replace(/\s+/g, ' ');

            console.debug(DEBUG_PREFIX + 'raw transcript:', userMessageRaw);

            // Detect trigger words
            let messageStart = -1;

            if (extension_settings.speech_recognition.Streaming.triggerWordsEnabled) {

                for (const triggerWord of extension_settings.speech_recognition.Streaming.triggerWords) {
                    const triggerPos = userMessageRaw.indexOf(triggerWord.toLowerCase());

                    // Trigger word not found or not starting message and just a substring
                    if (triggerPos == -1) { // | (triggerPos > 0 & userMessageFormatted[triggerPos-1] != " ")) {
                        console.debug(DEBUG_PREFIX + 'trigger word not found: ', triggerWord);
                    }
                    else {
                        console.debug(DEBUG_PREFIX + 'Found trigger word: ', triggerWord, ' at index ', triggerPos);
                        if (triggerPos < messageStart || messageStart == -1) { // & (triggerPos + triggerWord.length) < userMessageFormatted.length)) {
                            messageStart = triggerPos; // + triggerWord.length + 1;

                            if (!extension_settings.speech_recognition.Streaming.triggerWordsIncluded)
                                messageStart = triggerPos + triggerWord.length + 1;
                        }
                    }
                }
            } else {
                messageStart = 0;
            }

            if (messageStart == -1) {
                console.debug(DEBUG_PREFIX + 'message ignored, no trigger word preceding a message. Voice transcript: "' + userMessageOriginal + '"');
                if (extension_settings.speech_recognition.Streaming.debug) {
                    toastr.info(
                        'No trigger word preceding a message. Voice transcript: "' + userMessageOriginal + '"',
                        DEBUG_PREFIX + 'message ignored.',
                        { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true },
                    );
                }
            }
            else {
                userMessageFormatted = userMessageFormatted.substring(messageStart);
                // Trim non alphanumeric character from the start
                messageStart = 0;
                for (const i of userMessageFormatted) {
                    if (/^[\p{L}\p{M}]$/iu.test(i)) {
                        break;
                    }
                    messageStart += 1;
                }
                userMessageFormatted = userMessageFormatted.substring(messageStart);
                userMessageFormatted = userMessageFormatted.charAt(0).toUpperCase() + userMessageFormatted.substring(1);
                
                // Apply post-processing to the streaming transcript
                userMessageFormatted = postProcessText(userMessageFormatted);
                
                if (userMessageFormatted && userMessageFormatted.trim().length > 0) {
                    processTranscript(userMessageFormatted);
                } else {
                    console.debug(DEBUG_PREFIX + 'Empty streaming transcript after post-processing, ignoring');
                }
            }
        }
        else {
            console.debug(DEBUG_PREFIX + 'Received empty transcript, ignored');
        }
    }
    catch (error) {
        console.debug(error);
    }
    finally {
        inApiCall = false;
    }
}

// Text post-processing function
function postProcessText(text) {
    if (!text || typeof text !== 'string') return text;
    
    let processed = text;
    
    // Apply custom text replacements
    if (extension_settings.speech_recognition.textReplacements) {
        const replacements = extension_settings.speech_recognition.textReplacements;
        for (const [find, replace] of Object.entries(replacements)) {
            // Global case-insensitive replacement
            const regex = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            processed = processed.replace(regex, replace);
        }
    }
    
    // Clean up extra whitespace
    processed = processed.replace(/\s+/g, ' ').trim();
    
    return processed;
}

// VAD Functions
function startRecording() {
    if (audioRecording) return;
    
    console.debug(DEBUG_PREFIX + 'Starting recording');
    
    audioChunks = [];
    mediaRecorder.start();
    audioRecording = true;
    activateMicIcon($('#microphone_button'));
}

function stopRecording() {
    if (!audioRecording) return;
    
    console.debug(DEBUG_PREFIX + 'Stopping recording');
    
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    
    audioRecording = false;
    deactivateMicIcon($('#microphone_button'));
}


// Update volume indicator
function updateVolumeIndicator(volumeData) {
    const volumeBar = $('#speech_volume_bar');
    const volumeText = $('#speech_volume_text');
    const thresholdBar = $('#speech_threshold_bar');
    
    if (volumeBar.length === 0) return;
    
    // Calculate volume percentage using logarithmic scale for better visualization
    // Energy values are typically very small, so we use log scale
    const logEnergy = Math.log10(Math.max(1e-10, volumeData.energy));
    
        // Calculate threshold based on current VAD settings
        let thresholdForDisplay;
        if (extension_settings.speech_recognition.adaptiveVad) {
            // Use the actual threshold from VAD when adaptive mode is on
            thresholdForDisplay = volumeData.threshold;
        } else {
            // Calculate static threshold when adaptive mode is off
            // Use same logarithmic scale logic as VAD for consistency
            const sensitivity = extension_settings.speech_recognition.vadSensitivity !== undefined ? extension_settings.speech_recognition.vadSensitivity : 0.5;
            // Map sensitivity (0-1) to log energy range: -8 (high sensitivity) to -2 (low sensitivity)
            const minLog = -8;
            const maxLog = -2;
            const targetLogEnergy = minLog + (sensitivity * (maxLog - minLog));
            const fixedThreshold = Math.pow(10, targetLogEnergy);
            
            // Use the same threshold calculation as VAD for non-adaptive mode
            thresholdForDisplay = fixedThreshold * 0.5; // Signal must be 50% above threshold
        }
    
    const logThreshold = Math.log10(Math.max(1e-10, thresholdForDisplay));
    const minLog = -8; // Minimum expected log energy
    const maxLog = -2; // Maximum expected log energy
    
    const volumePercent = Math.min(100, Math.max(0, ((logEnergy - minLog) / (maxLog - minLog)) * 100));
    const thresholdPercent = Math.min(100, Math.max(0, ((logThreshold - minLog) / (maxLog - minLog)) * 100));
    
    // Update main volume bar
    volumeBar.css('width', volumePercent + '%');
    
    // Update threshold indicator bar
    if (thresholdBar.length > 0) {
        thresholdBar.css('left', thresholdPercent + '%');
    }
    
    // Update color based on state
    if (volumeData.willTrigger) {
        volumeBar.css('background-color', '#ff4444'); // Red for trigger
    } else if (volumeData.currentState) {
        volumeBar.css('background-color', '#ffaa00'); // Orange for recording
    } else {
        volumeBar.css('background-color', '#44ff44'); // Green for idle
    }
    
    // Update text with more detailed information
    if (volumeText.length > 0) {
        const sensitivity = extension_settings.speech_recognition.vadSensitivity !== undefined ? extension_settings.speech_recognition.vadSensitivity : 0.5;
        let statusText = `Volume: ${Math.round(volumePercent)}%`;
        
        if (volumeData.willTrigger) {
            statusText += ' (TRIGGER)';
        } else if (volumeData.currentState) {
            statusText += ' (RECORDING)';
        }
        
        // Add debug info in development
        if (extension_settings.speech_recognition.debug) {
            statusText += ` | Sens: ${sensitivity.toFixed(1)}`;
        }
        
        volumeText.text(statusText);
    }
    
    // Debug logging for VAD behavior
    if (extension_settings.speech_recognition.debug && (volumeData.willTrigger || volumeData.currentState)) {
        console.debug(DEBUG_PREFIX + 'VAD Update:', {
            energy: volumeData.energy.toExponential(2),
            threshold: volumeData.threshold.toExponential(2),
            signal: volumeData.signal.toExponential(2),
            willTrigger: volumeData.willTrigger,
            currentState: volumeData.currentState,
            sensitivity: (extension_settings.speech_recognition.vadSensitivity !== undefined ? extension_settings.speech_recognition.vadSensitivity : 0.5).toFixed(2)
        });
    }
}

async function processTranscript(transcript) {
    try {
        const transcriptOriginal = transcript;
        let transcriptFormatted = transcriptOriginal.trim();

        // Apply post-processing to the transcript
        transcriptFormatted = postProcessText(transcriptFormatted);

        if (transcriptFormatted.trim().length > 0) {
            console.debug(DEBUG_PREFIX + 'recorded transcript: "' + transcriptFormatted + '"');
            const messageMode = extension_settings.speech_recognition.messageMode;
            console.debug(DEBUG_PREFIX + 'mode: ' + messageMode);

            let transcriptLower = transcriptFormatted.toLowerCase();
            // remove punctuation
            let transcriptRaw = transcriptLower.replace(/[^\w\s\']|_/g, '').replace(/\s+/g, ' ');

            // Check message mapping
            if (extension_settings.speech_recognition.messageMappingEnabled) {
                // also check transcriptFormatted for non ascii keys
                for (const s of [transcriptRaw, transcriptFormatted]) {
                    console.debug(DEBUG_PREFIX + 'Start searching message mapping into:', s);
                    for (const key in extension_settings.speech_recognition.messageMapping) {
                        console.debug(DEBUG_PREFIX + 'message mapping searching: ', key, '=>', extension_settings.speech_recognition.messageMapping[key]);
                        if (s.includes(key)) {
                            var message = extension_settings.speech_recognition.messageMapping[key];
                            console.debug(DEBUG_PREFIX + 'message mapping found: ', key, '=>', extension_settings.speech_recognition.messageMapping[key]);
                            $('#send_textarea').val(message);

                            if (messageMode == 'auto_send') await getContext().generate();
                            return;
                        }
                    }
                }
            }

            console.debug(DEBUG_PREFIX + 'no message mapping found, processing transcript as normal message');
            const textarea = $('#send_textarea');

            switch (messageMode) {
                case 'auto_send':
                    console.debug('Sending message: ' + transcriptFormatted);
                    // clear message area to avoid double message
                    textarea.val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

                    await sendMessageAsUser(transcriptFormatted);
                    await getContext().generate();

                    $('#debug_output').text('<SST-module DEBUG>: message sent: "' + transcriptFormatted + '"');
                    break;

                case 'replace':
                    console.debug(DEBUG_PREFIX + 'Replacing message');
                    textarea.val(transcriptFormatted);
                    break;

                case 'append':
                    console.debug(DEBUG_PREFIX + 'Appending message');
                    const existingMessage = textarea.val();
                    textarea.val(existingMessage + ' ' + transcriptFormatted);
                    break;

                default:
                    console.debug(DEBUG_PREFIX + 'Not supported stt message mode: ' + messageMode);

            }
        }
        else {
            console.debug(DEBUG_PREFIX + 'Empty transcript after post-processing, do nothing');
        }
    }
    catch (error) {
        console.debug(error);
    }
}

function loadNavigatorAudioRecording() {
    if (navigator.mediaDevices.getUserMedia) {
        console.debug(DEBUG_PREFIX + ' getUserMedia supported by browser.');
        const micButton = $('#microphone_button');
        const micClickHandler = function () {
            micButton.off('click');
            navigator.mediaDevices.getUserMedia(constraints).then(function (s) {
                onSuccess(s);
                if (!audioRecording) {
                    mediaRecorder.start();
                    console.debug(DEBUG_PREFIX + 'recorder started, state: ' + mediaRecorder.state);
                    audioRecording = true;
                    activateMicIcon(micButton);
                }
            }, onError);
        };

        let onSuccess = function (stream) {
            const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
            audioContext = new AudioContext(!isFirefox ? { sampleRate: 16000 } : null);
            mediaStream = stream;
            const source = audioContext.createMediaStreamSource(stream);
            
            // Get VAD settings from defaults if not set
            const sensitivity = extension_settings.speech_recognition.vadSensitivity !== undefined ? extension_settings.speech_recognition.vadSensitivity : 0.5;
            const adaptiveVad = extension_settings.speech_recognition.adaptiveVad !== false; // Default to true
            
            // Calculate threshold for non-adaptive mode
            let threshold;
            if (!adaptiveVad) {
                // Use same logarithmic scale logic as VAD for consistency
                // Map sensitivity (0-1) to log energy range: -8 (high sensitivity) to -2 (low sensitivity)
                const minLog = -8;
                const maxLog = -2;
                const targetLogEnergy = minLog + (sensitivity * (maxLog - minLog));
                threshold = Math.pow(10, targetLogEnergy);
            }
            
            const settings = {
                source: source,
                sensitivity: sensitivity,
                adaptiveVad: adaptiveVad,
                threshold: threshold,
                voice_start: function () {
                    if (!audioRecording && extension_settings.speech_recognition.voiceActivationEnabled) {
                        console.debug(DEBUG_PREFIX + 'Voice started - beginning recording');
                        startRecording();
                    }
                },
                voice_stop: function () {
                    if (audioRecording && extension_settings.speech_recognition.voiceActivationEnabled) {
                        console.debug(DEBUG_PREFIX + 'Voice stopped - stopping recording');
                        stopRecording();
                    }
                },
                voice_volume_update: function (volumeData) {
                    updateVolumeIndicator(volumeData);
                },
            };

            // only create VAD if voice activation is ON
            if (extension_settings.speech_recognition.voiceActivationEnabled) {
                vadInstance = new VAD(settings);
            }

            mediaRecorder = new MediaRecorder(stream);

            micButton.off('click').on('click', function () {
                if (!audioRecording) {
                    if (!mediaRecorder) {
                        // go back through the same init path
                        micButton.off('click');
                        navigator.mediaDevices.getUserMedia(constraints).then(onSuccess, onError);
                        return;
                    }
                    mediaRecorder.start();
                    console.debug(DEBUG_PREFIX + mediaRecorder.state);
                    console.debug(DEBUG_PREFIX + 'recorder started');
                    audioRecording = true;
                    activateMicIcon(micButton);
                }
                else {
                    mediaRecorder.stop();
                    console.debug(DEBUG_PREFIX + mediaRecorder.state);
                    console.debug(DEBUG_PREFIX + 'recorder stopped');
                    audioRecording = false;
                    deactivateMicIcon(micButton);
                }
            });

            mediaRecorder.onstop = async function () {
                console.debug(DEBUG_PREFIX + 'data available after MediaRecorder.stop() called: ', audioChunks.length, ' chunks');
                
                // Validate chunks before processing
                const validChunks = audioChunks.filter(chunk => chunk && chunk.size > 0);
                if (validChunks.length === 0) {
                    console.debug(DEBUG_PREFIX + 'No valid audio chunks to process in onstop handler');
                    return;
                }
                
                console.debug(DEBUG_PREFIX + `Using ${validChunks.length} valid chunks out of ${audioChunks.length} total in onstop`);
                
                // Try to create blob with explicit MIME type and validate chunks more thoroughly
                let audioBlob;
                try {
                    // Filter out any chunks that might be corrupted
                    const cleanChunks = validChunks.filter(chunk => {
                        return chunk && chunk.size > 0 && chunk.type !== '';
                    });
                    
                    if (cleanChunks.length === 0) {
                        console.debug(DEBUG_PREFIX + 'No clean chunks available for blob creation');
                        return;
                    }
                    
                    // Try with audio/webm; if that fails, try audio/ogg as fallback
                    const mimeType = mediaRecorder.mimeType || 'audio/webm';
                    audioBlob = new Blob(cleanChunks, { type: mimeType });
                    
                    console.debug(DEBUG_PREFIX + `Created blob with ${cleanChunks.length} chunks, MIME type: ${mimeType}`);
                } catch (blobError) {
                    console.error(DEBUG_PREFIX + 'Error creating audio blob:', blobError);
                    return;
                }
                
                // Validate blob before creating array buffer
                if (audioBlob.size === 0) {
                    console.debug(DEBUG_PREFIX + 'Empty audio blob in onstop handler, cannot process audio');
                    return;
                }
                
                let arrayBuffer;
                try {
                    arrayBuffer = await audioBlob.arrayBuffer();
                } catch (arrayBufferError) {
                    console.error(DEBUG_PREFIX + 'Error creating array buffer from blob:', arrayBufferError);
                    return;
                }

                // Validate array buffer
                if (arrayBuffer.byteLength === 0) {
                    console.debug(DEBUG_PREFIX + 'Empty array buffer in onstop handler, cannot process audio');
                    console.debug(DEBUG_PREFIX + 'Blob info:', {
                        blobSize: audioBlob.size,
                        mimeType: audioBlob.type,
                        chunkCount: validChunks.length,
                        chunkSizes: validChunks.map(chunk => chunk.size),
                        cleanChunkCount: validChunks.filter(chunk => chunk && chunk.size > 0 && chunk.type !== '').length
                    });
                    return;
                }
                
                console.debug(DEBUG_PREFIX + `Audio blob size in onstop: ${audioBlob.size}, array buffer size: ${arrayBuffer.byteLength}, MIME type: ${audioBlob.type}`);

                // Use AudioContext to decode our array buffer into an audio buffer
                let audioBuffer;
                try {
                    const audioContext = new AudioContext();
                    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                    audioChunks = [];
                } catch (decodeError) {
                    console.error(DEBUG_PREFIX + 'Error decoding audio data in onstop handler:', decodeError);
                    console.error(DEBUG_PREFIX + 'Audio info in onstop:', {
                        blobSize: audioBlob.size,
                        arrayBufferSize: arrayBuffer.byteLength,
                        mimeType: audioBlob.type,
                        chunkCount: validChunks.length,
                        chunkSizes: validChunks.map(chunk => chunk.size)
                    });
                    return;
                }

                // Check recording duration using AudioBuffer.duration
                const recordingDurationMs = audioBuffer.duration * 1000; // Convert to milliseconds
                const minDurationMs = extension_settings.speech_recognition.minRecordingDuration || 500;
                
                // Debug logging for recording duration
                console.debug(DEBUG_PREFIX + `Recording duration: ${recordingDurationMs.toFixed(0)}ms, minimum required: ${minDurationMs}ms`);
                
                // Validate minimum duration
                if (recordingDurationMs < minDurationMs) {
                    console.debug(DEBUG_PREFIX + `Recording too short: ${recordingDurationMs.toFixed(0)}ms < ${minDurationMs}ms, skipping transcription`);
                    return;
                }

                const wavBlob = await convertAudioBufferToWavBlob(audioBuffer);
                const transcript = await sttProvider.processAudio(wavBlob);

                console.debug(DEBUG_PREFIX + 'received transcript:', transcript);
                
                // Apply post-processing
                const processedTranscript = postProcessText(transcript);
                
                if (processedTranscript && processedTranscript.trim().length > 0) {
                    processTranscript(processedTranscript);
                } else {
                    console.debug(DEBUG_PREFIX + 'Empty transcript after post-processing, ignoring');
                }

                // If voice activation is OFF, release mic after each recording
                if (!extension_settings.speech_recognition.voiceActivationEnabled) {
                    try {
                        mediaRecorder.stream.getTracks().forEach(t => t.stop());
                    } catch (e) {
                        console.error(DEBUG_PREFIX + 'error stopping media stream tracks:', e);
                    }
                    mediaRecorder = null;
                    micButton.off('click').on('click', micClickHandler);
                }
            };

            mediaRecorder.ondataavailable = function (e) {
                audioChunks.push(e.data);
            };
        };

        let onError = function (err) {
            console.debug(DEBUG_PREFIX + 'The following error occured: ' + err);
        };

        // only open mic immediately if voice activation is enabled
        if (extension_settings.speech_recognition.voiceActivationEnabled) {
            navigator.mediaDevices.getUserMedia(constraints).then(onSuccess, onError);
        } else {
            micButton.off('click').on('click', micClickHandler);
        }

    } else {
        console.debug(DEBUG_PREFIX + 'getUserMedia not supported on your browser!');
        toastr.error('getUserMedia not supported', DEBUG_PREFIX + 'not supported for your browser.', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
    }
}

//##############//
// STT Provider //
//##############//

function loadSttProvider(provider) {
    //Clear the current config and add new config
    $('#speech_recognition_provider_settings').html('');

    // Init provider references
    extension_settings.speech_recognition.currentProvider = provider;
    sttProviderName = provider;

    if (!(sttProviderName in extension_settings.speech_recognition)) {
        console.warn(`Provider ${sttProviderName} not in Extension Settings, initiatilizing provider in settings`);
        extension_settings.speech_recognition[sttProviderName] = {};
    }

    $('#speech_recognition_provider').val(sttProviderName);

    stopCurrentProvider();

    if (sttProviderName == 'None') {
        $('#microphone_button').hide();
        $('#speech_recognition_message_mode_div').hide();
        $('#speech_recognition_message_mapping_div').hide();
        $('#speech_recognition_language_div').hide();
        $('#speech_recognition_ptt_div').hide();
        $('#speech_recognition_voice_activation_enabled_div').hide();
        return;
    }

    $('#speech_recognition_message_mode_div').show();
    $('#speech_recognition_message_mapping_div').show();
    $('#speech_recognition_language_div').show();

    sttProvider = new sttProviders[sttProviderName];

    // Init provider settings
    $('#speech_recognition_provider_settings').append(sttProvider.settingsHtml);

    // Use microphone button as push to talk
    if (sttProviderName == 'Browser') {
        $('#speech_recognition_language_div').hide();
        sttProvider.processTranscriptFunction = processTranscript;
        sttProvider.loadSettings(extension_settings.speech_recognition[sttProviderName]);
        $('#microphone_button').show();
    }

    const nonStreamingProviders = ['Vosk', 'OpenAI', 'Whisper (Extras)', 'Whisper (Local)', 'Whisper (cpp)', 'KoboldCpp'];
    if (nonStreamingProviders.includes(sttProviderName)) {
        sttProvider.loadSettings(extension_settings.speech_recognition[sttProviderName]);
        loadNavigatorAudioRecording();
        $('#microphone_button').show();
    }

    if (sttProviderName == 'Streaming') {
        sttProvider.loadSettings(extension_settings.speech_recognition[sttProviderName]);
        $('#microphone_button').off('click');
        $('#microphone_button').hide();
    }

    $('#speech_recognition_ptt_div').toggle(sttProviderName != 'Streaming');
    $('#speech_recognition_voice_activation_enabled_div').toggle(sttProviderName != 'Streaming');
}

/**
 * Set the microphone icon as active. Must be called when recording starts.
 * @param {JQuery} micButton - The jQuery object of the microphone button.
 */
function activateMicIcon(micButton) {
    micButton.toggleClass('fa-microphone fa-microphone-slash');
    micButton.prop('title', 'Click to end and transcribe');
}

/**
 * Set the microphone icon as inactive. Must be called when recording ends.
 * @param {JQuery} micButton - The jQuery object of the microphone button.
 */
function deactivateMicIcon(micButton) {
    micButton.toggleClass('fa-microphone fa-microphone-slash');
    micButton.prop('title', 'Click to speak');
}

function stopCurrentProvider() {
    console.debug(DEBUG_PREFIX + 'stop current provider');
    
    // Stop VAD instance
    if (vadInstance) {
        vadInstance = null;
    }
    
    if (mediaRecorder) {
        mediaRecorder.onstop = null;
        mediaRecorder.ondataavailable = null;
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
        mediaRecorder.stop();
        mediaRecorder = null;
    }
    if (audioRecording) {
        audioRecording = false;
        const micButton = $('#microphone_button');
        if (micButton.is(':visible')) {
            deactivateMicIcon(micButton);
        }
    }
}

function onSttLanguageChange() {
    extension_settings.speech_recognition[sttProviderName].language = String($('#speech_recognition_language').val());
    sttProvider.loadSettings(extension_settings.speech_recognition[sttProviderName]);
    saveSettingsDebounced();
}

function onSttProviderChange() {
    const sttProviderSelection = $('#speech_recognition_provider').val();
    loadSttProvider(sttProviderSelection);
    saveSettingsDebounced();
}

function onSttProviderSettingsInput() {
    sttProvider.onSettingsChange();

    // Persist changes to SillyTavern stt extension settings
    extension_settings.speech_recognition[sttProviderName] = sttProvider.settings;
    saveSettingsDebounced();
    console.info(`Saved settings ${sttProviderName} ${JSON.stringify(sttProvider.settings)}`);
}

//#############################//
//  Extension UI and Settings  //
//#############################//

const defaultSettings = {
    currentProvider: 'None',
    messageMode: 'append',
    messageMappingText: '',
    messageMapping: [],
    messageMappingEnabled: false,
    voiceActivationEnabled: false,
    /**
     * @type {KeyCombo} Push-to-talk key combo
     */
    ptt: null,
    minRecordingDuration: 500, // Minimum recording duration in milliseconds (default: 500ms)
};

function loadSettings() {
    if (Object.keys(extension_settings.speech_recognition).length === 0) {
        Object.assign(extension_settings.speech_recognition, defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings.speech_recognition[key] === undefined) {
            extension_settings.speech_recognition[key] = defaultSettings[key];
        }
    }

    if (extension_settings.speech_recognition.currentProvider === 'Whisper (OpenAI)') {
        extension_settings.speech_recognition.currentProvider = 'OpenAI';
    }
    if (extension_settings.speech_recognition['Whisper (OpenAI)'] && !extension_settings.speech_recognition['OpenAI']) {
        extension_settings.speech_recognition['OpenAI'] = extension_settings.speech_recognition['Whisper (OpenAI)'];
    }

    $('#speech_recognition_enabled').prop('checked', extension_settings.speech_recognition.enabled);
    $('#speech_recognition_message_mode').val(extension_settings.speech_recognition.messageMode);

    if (extension_settings.speech_recognition.messageMappingText.length > 0) {
        $('#speech_recognition_message_mapping').val(extension_settings.speech_recognition.messageMappingText);
    }

    $('#speech_recognition_message_mapping_enabled').prop('checked', extension_settings.speech_recognition.messageMappingEnabled);
    $('#speech_recognition_ptt').val(extension_settings.speech_recognition.ptt ? formatPushToTalkKey(extension_settings.speech_recognition.ptt) : '');
    $('#speech_recognition_voice_activation_enabled').prop('checked', extension_settings.speech_recognition.voiceActivationEnabled);
    
    // Load VAD sensitivity setting
    const sensitivity = extension_settings.speech_recognition.vadSensitivity !== undefined ? extension_settings.speech_recognition.vadSensitivity : 0.5;
    $('#speech_recognition_vad_sensitivity').val(sensitivity);
    $('#speech_recognition_vad_sensitivity_value').text(sensitivity.toFixed(2));
    
    
    // Load post-processing settings
    const removeBrackets = extension_settings.speech_recognition.removeBrackets !== false; // Default to true
    $('#speech_recognition_remove_brackets').prop('checked', removeBrackets);
    
    // Load text replacements
    if (extension_settings.speech_recognition.textReplacements) {
        const replacementLines = Object.entries(extension_settings.speech_recognition.textReplacements)
            .map(([find, replace]) => `${find} = ${replace}`)
            .join('\n');
        $('#speech_recognition_text_replacements').val(replacementLines);
    }
    
    // Load adaptive VAD setting and initialize UI state
    const adaptiveVad = extension_settings.speech_recognition.adaptiveVad !== false; // Default to true
    $('#speech_recognition_adaptive_vad').prop('checked', adaptiveVad);
    
    // Load minimum recording duration setting
    const minDuration = extension_settings.speech_recognition.minRecordingDuration !== undefined ? extension_settings.speech_recognition.minRecordingDuration : 500;
    $('#speech_recognition_min_duration').val(minDuration);
    $('#speech_recognition_min_duration_value').text(minDuration + 'ms');
    
    // Always show sensitivity slider since it affects both adaptive and non-adaptive modes
    $('#speech_recognition_vad_sensitivity_div').show();
}

async function onMessageModeChange() {
    extension_settings.speech_recognition.messageMode = $('#speech_recognition_message_mode').val();

    if (sttProviderName != 'Browser' && extension_settings.speech_recognition.messageMode == 'auto_send') {
        $('#speech_recognition_wait_response_div').show();
    }
    else {
        $('#speech_recognition_wait_response_div').hide();
    }

    saveSettingsDebounced();
}

async function onMessageMappingChange() {
    let array = String($('#speech_recognition_message_mapping').val()).split(',');
    array = array.map(element => { return element.trim(); });
    array = array.filter((str) => str !== '');
    extension_settings.speech_recognition.messageMapping = {};
    for (const text of array) {
        if (text.includes('=')) {
            const pair = text.toLowerCase().split('=');
            extension_settings.speech_recognition.messageMapping[pair[0].trim()] = pair[1].trim();
            console.debug(DEBUG_PREFIX + 'Added mapping', pair[0], '=>', extension_settings.speech_recognition.messageMapping[pair[0]]);
        }
        else {
            console.debug(DEBUG_PREFIX + 'Wrong syntax for message mapping, no \'=\' found in:', text);
        }
    }

    $('#speech_recognition_message_mapping_status').text('Message mapping updated to: ' + JSON.stringify(extension_settings.speech_recognition.messageMapping));
    console.debug(DEBUG_PREFIX + 'Updated message mapping', extension_settings.speech_recognition.messageMapping);
    extension_settings.speech_recognition.messageMappingText = $('#speech_recognition_message_mapping').val();
    saveSettingsDebounced();
}

async function onMessageMappingEnabledClick() {
    extension_settings.speech_recognition.messageMappingEnabled = $('#speech_recognition_message_mapping_enabled').is(':checked');
    saveSettingsDebounced();
}

function onVoiceActivationEnabledChange() {
    const enabled = !!$('#speech_recognition_voice_activation_enabled').prop('checked');
    extension_settings.speech_recognition.voiceActivationEnabled = enabled;

    const micButton = $('#microphone_button');

    if (enabled) {
        micButton.off('click');
        loadNavigatorAudioRecording();
    } else {
        if (!audioRecording) {
            if (mediaRecorder && mediaRecorder.stream) {
                try {
                    mediaRecorder.stream.getTracks().forEach(t => t.stop());
                } catch (e) {
                    console.error(DEBUG_PREFIX + 'error stopping media stream tracks:', e);
                }
            }
            mediaRecorder = null;

            // rebind to the lazy handler
            micButton.off('click');
            loadNavigatorAudioRecording();
        }
    }

    saveSettingsDebounced();
}

function onAdaptiveVadChange() {
    const enabled = !!$('#speech_recognition_adaptive_vad').prop('checked');
    extension_settings.speech_recognition.adaptiveVad = enabled;
    
    // Always show sensitivity slider since it affects both adaptive and non-adaptive modes
    $('#speech_recognition_vad_sensitivity_div').show();
    
    // Restart VAD instance with new settings if voice activation is enabled
    if (extension_settings.speech_recognition.voiceActivationEnabled && mediaStream) {
        // Stop current VAD instance
        if (vadInstance) {
            vadInstance = null;
        }
        
        // Recreate VAD with updated settings
        const sensitivity = extension_settings.speech_recognition.vadSensitivity !== undefined ? extension_settings.speech_recognition.vadSensitivity : 0.5;
        const adaptiveVad = enabled;
        
        // Calculate threshold for non-adaptive mode
        let threshold;
        if (!adaptiveVad) {
            // Use same logarithmic scale logic as VAD for consistency
            // Map sensitivity (0-1) to log energy range: -8 (high sensitivity) to -2 (low sensitivity)
            const minLog = -8;
            const maxLog = -2;
            const targetLogEnergy = minLog + (sensitivity * (maxLog - minLog));
            threshold = Math.pow(10, targetLogEnergy);
        }
        
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(mediaStream);
        
        const settings = {
            source: source,
            sensitivity: sensitivity,
            adaptiveVad: adaptiveVad,
            threshold: threshold,
            voice_start: function () {
                if (!audioRecording && extension_settings.speech_recognition.voiceActivationEnabled) {
                    console.debug(DEBUG_PREFIX + 'Voice started - beginning recording');
                    startRecording();
                }
            },
            voice_stop: function () {
                if (audioRecording && extension_settings.speech_recognition.voiceActivationEnabled) {
                    console.debug(DEBUG_PREFIX + 'Voice stopped - stopping recording');
                    stopRecording();
                }
            },
            voice_volume_update: function (volumeData) {
                updateVolumeIndicator(volumeData);
            },
        };
        
        vadInstance = new VAD(settings);
        console.debug(DEBUG_PREFIX + 'VAD restarted with adaptiveVad:', adaptiveVad);
    }
    
    saveSettingsDebounced();
}

function onVadSensitivityChange() {
    const sensitivity = parseFloat($('#speech_recognition_vad_sensitivity').val());
    extension_settings.speech_recognition.vadSensitivity = sensitivity;
    $('#speech_recognition_vad_sensitivity_value').text(sensitivity.toFixed(2));
    
    // Update VAD instance if it exists
    if (vadInstance && vadInstance.options) {
        vadInstance.options.sensitivity = sensitivity;
        
        // Update threshold for non-adaptive mode
        if (!vadInstance.options.adaptiveVad) {
            // Use same logarithmic scale logic as VAD for consistency
            // Map sensitivity (0-1) to log energy range: -8 (high sensitivity) to -2 (low sensitivity)
            const minLog = -8;
            const maxLog = -2;
            const targetLogEnergy = minLog + (sensitivity * (maxLog - minLog));
            const threshold = Math.pow(10, targetLogEnergy);
            vadInstance.options.threshold = threshold;
        }
    }
    
    saveSettingsDebounced();
}

function onMinRecordingDurationChange() {
    const duration = parseInt($('#speech_recognition_min_duration').val());
    extension_settings.speech_recognition.minRecordingDuration = duration;
    $('#speech_recognition_min_duration_value').text(duration + 'ms');
    saveSettingsDebounced();
}


function onRemoveBracketsChange() {
    const enabled = !!$('#speech_recognition_remove_brackets').prop('checked');
    extension_settings.speech_recognition.removeBrackets = enabled;
    saveSettingsDebounced();
}

function onTextReplacementsChange() {
    const text = $('#speech_recognition_text_replacements').val();
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    extension_settings.speech_recognition.textReplacements = {};
    
    for (const line of lines) {
        if (line.includes('=')) {
            const [find, replace] = line.split('=').map(part => part.trim());
            if (find && find.length > 0) {
                extension_settings.speech_recognition.textReplacements[find] = replace || '';
                console.debug(DEBUG_PREFIX + 'Added text replacement:', find, '=>', replace || '(remove)');
            }
        } else {
            console.debug(DEBUG_PREFIX + 'Invalid text replacement format, missing "=":', line);
        }
    }
    
    console.debug(DEBUG_PREFIX + 'Updated text replacements:', extension_settings.speech_recognition.textReplacements);
    saveSettingsDebounced();
}

async function convertAudioBufferToWavBlob(audioBuffer) {
    return new Promise(function (resolve) {
        var worker = new Worker('/scripts/extensions/third-party/Extension-Speech-Recognition/wave-worker.js');

        worker.onmessage = function (e) {
            var blob = new Blob([e.data.buffer], { type: 'audio/wav' });
            resolve(blob);
        };

        let pcmArrays = [];
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            pcmArrays.push(audioBuffer.getChannelData(i));
        }

        worker.postMessage({
            pcmArrays,
            config: { sampleRate: audioBuffer.sampleRate },
        });
    });
}

/**
 * @typedef {object} KeyCombo
 * @property {string} key
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {boolean} meta
 */

/**
 * Convert a native keyboard event to a key combo object.
 * @param {KeyboardEvent} event Native keyboard event
 * @returns {KeyCombo} Key combo object
 */
function keyboardEventToKeyCombo(event) {
    return {
        code: event.code,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
    };
}

/**
 * Key labels for Windows.
 * @type {Record<string, string>}
 */
const WINDOWS_LABELS = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Win',
};

/**
 * Key labels for macOS.
 * @type {Record<string, string>}
 */
const MAC_LABELS = {
    ctrl: '⌃',
    alt: '⌥',
    shift: '⇧',
    meta: '⌘',
};

/**
 * Key labels for Linux.
 * @type {Record<string, string>}
 */
const LINUX_LABELS = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
};

/**
 * Gets the key labels for the current user agent.
 * @returns {Record<string, string>}
 */
function getLabelsForUserAgent() {
    const userAgent = navigator.userAgent;
    if (userAgent.includes('Macintosh')) {
        return MAC_LABELS;
    } else if (userAgent.includes('Windows')) {
        return WINDOWS_LABELS;
    } else {
        return LINUX_LABELS;
    }
}

/**
 * Format a key combo object as a string.
 * @param {KeyCombo} key Key combo object
 * @returns {string} String representation of the key combo
 */
function formatPushToTalkKey(key) {
    const labels = getLabelsForUserAgent();
    const parts = [];
    if (key.ctrl) {
        parts.push(labels.ctrl);
    }
    if (key.alt) {
        parts.push(labels.alt);
    }
    if (key.shift) {
        parts.push(labels.shift);
    }
    if (key.meta) {
        parts.push(labels.meta);
    }
    parts.push(key.code);
    return parts.join(' + ');
}

/**
 * Check if a key combo object matches a keyboard event.
 * @param {KeyCombo} keyCombo Key combo object
 * @param {KeyboardEvent} event Original event
 * @returns
 */
function isKeyComboMatch(keyCombo, event) {
    return keyCombo.code === event.code
        && keyCombo.ctrl === event.ctrlKey
        && keyCombo.alt === event.altKey
        && keyCombo.shift === event.shiftKey
        && keyCombo.meta === event.metaKey;
}

/**
 * Check if push-to-talk is enabled.
 * @returns {boolean} True if push-to-talk is enabled
 */
function isPushToTalkEnabled() {
    return extension_settings.speech_recognition.ptt !== null && sttProviderName !== 'Streaming' && sttProviderName !== 'None';
}

let lastPressTime = 0;

/**
 * Event handler for push-to-talk start.
 * @param {KeyboardEvent} event Event
 */
function processPushToTalkStart(event) {
    // Push-to-talk not enabled
    if (!isPushToTalkEnabled()) {
        return;
    }

    const key = extension_settings.speech_recognition.ptt;

    // Key combo match - toggle recording
    if (isKeyComboMatch(key, event) && !event.repeat) {
        console.debug(DEBUG_PREFIX + 'Push-to-talk key pressed');
        lastPressTime = Date.now();
        $('#microphone_button').trigger('click');
    }
}

/**
 * Event handler for push-to-talk end.
 * @param {KeyboardEvent} event Event
 */
function processPushToTalkEnd(event) {
    // Push-to-talk not enabled
    if (!isPushToTalkEnabled()) {
        return;
    }

    /** @type {KeyCombo} */
    const key = extension_settings.speech_recognition.ptt;

    // Key combo match (without modifier keys)
    if (key.code === event.code) {
        console.debug(DEBUG_PREFIX + 'Push-to-talk key released');

        // If the key was held for more than 500ms and still recording, stop recording
        if (Date.now() - lastPressTime > 500 && audioRecording) {
            $('#microphone_button').trigger('click');
        }
    }
}

$(document).ready(function () {
    function addExtensionControls() {
        const settingsHtml = `
        <div id="speech_recognition_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Speech Recognition</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div>
                        <span>Select Speech-to-text Provider</span> </br>
                        <select id="speech_recognition_provider">
                        </select>
                    </div>
                    <div id="speech_recognition_language_div">
                        <span>Speech Language</span> </br>
                        <select id="speech_recognition_language">
                            <option value="">-- Automatic --</option>
                            <option value="af">Afrikaans</option>
                            <option value="ar">Arabic</option>
                            <option value="hy">Armenian</option>
                            <option value="az">Azerbaijani</option>
                            <option value="be">Belarusian</option>
                            <option value="bs">Bosnian</option>
                            <option value="bg">Bulgarian</option>
                            <option value="ca">Catalan</option>
                            <option value="zh">Chinese</option>
                            <option value="hr">Croatian</option>
                            <option value="cs">Czech</option>
                            <option value="da">Danish</option>
                            <option value="nl">Dutch</option>
                            <option value="en">English</option>
                            <option value="et">Estonian</option>
                            <option value="fi">Finnish</option>
                            <option value="fr">French</option>
                            <option value="gl">Galician</option>
                            <option value="de">German</option>
                            <option value="el">Greek</option>
                            <option value="he">Hebrew</option>
                            <option value="hi">Hindi</option>
                            <option value="hu">Hungarian</option>
                            <option value="is">Icelandic</option>
                            <option value="id">Indonesian</option>
                            <option value="it">Italian</option>
                            <option value="ja">Japanese</option>
                            <option value="kn">Kannada</option>
                            <option value="kk">Kazakh</option>
                            <option value="ko">Korean</option>
                            <option value="lv">Latvian</option>
                            <option value="lt">Lithuanian</option>
                            <option value="mk">Macedonian</option>
                            <option value="ms">Malay</option>
                            <option value="mr">Marathi</option>
                            <option value="mi">Maori</option>
                            <option value="ne">Nepali</option>
                            <option value="no">Norwegian</option>
                            <option value="fa">Persian</option>
                            <option value="pl">Polish</option>
                            <option value="pt">Portuguese</option>
                            <option value="ro">Romanian</option>
                            <option value="ru">Russian</option>
                            <option value="sr">Serbian</option>
                            <option value="sk">Slovak</option>
                            <option value="sl">Slovenian</option>
                            <option value="es">Spanish</option>
                            <option value="sw">Swahili</option>
                            <option value="sv">Swedish</option>
                            <option value="tl">Tagalog</option>
                            <option value="ta">Tamil</option>
                            <option value="th">Thai</option>
                            <option value="tr">Turkish</option>
                            <option value="uk">Ukrainian</option>
                            <option value="ur">Urdu</option>
                            <option value="vi">Vietnamese</option>
                            <option value="cy">Welsh</option>
                        </select>
                    </div>
                    <div id="speech_recognition_ptt_div">
                        <span>Recording Hotkey</span>
                        <i title="Press the designated keystroke to start the recording. Press again to stop. Only works if a browser tab is in focus." class="fa-solid fa-info-circle opacity50p"></i>
                        <input readonly type="text" id="speech_recognition_ptt" class="text_pole" placeholder="Click to set push-to-talk key">
                    </div>
                    <div id="speech_recognition_voice_activation_enabled_div" title="Automatically start and stop recording when you start and stop speaking.">
                        <label class="checkbox_label" for="speech_recognition_voice_activation_enabled">
                            <input type="checkbox" id="speech_recognition_voice_activation_enabled" name="speech_recognition_voice_activation_enabled">
                            <small>Enable activation by voice</small>
                        </label>
                    </div>
                    <div id="speech_recognition_volume_indicator_div" title="Shows current audio volume level and VAD trigger status.">
                        <span>Volume Indicator</span> </br>
                        <div style="width: 100%; height: 20px; background-color: #333; border-radius: 10px; overflow: hidden; position: relative;">
                            <div id="speech_volume_bar" style="height: 100%; width: 0%; background-color: #44ff44; transition: width 0.1s, background-color 0.1s;"></div>
                            <div id="speech_threshold_bar" style="position: absolute; top: 0; width: 2px; height: 100%; background-color: rgba(255, 255, 255, 0.8); left: 50%; transition: left 0.1s;"></div>
                        </div>
                        <span id="speech_volume_text">Volume: 0%</span>
                    </div>
                    <div id="speech_recognition_adaptive_vad_div" title="Enable adaptive VAD that adjusts to background noise. Disable for simple threshold-based detection.">
                        <label class="checkbox_label" for="speech_recognition_adaptive_vad">
                            <input type="checkbox" id="speech_recognition_adaptive_vad" name="speech_recognition_adaptive_vad" checked>
                            <small>Enable adaptive VAD</small>
                        </label>
                    </div>
                    <div id="speech_recognition_vad_sensitivity_div" title="Adjust recording activation threshold. Lower values make it more sensitive to voice, higher values make it less sensitive.">
                        <span>Recording Activation Threshold</span> </br>
                        <input type="range" id="speech_recognition_vad_sensitivity" min="0" max="1" step="0.01" value="0.5" class="text_pole">
                        <span id="speech_recognition_vad_sensitivity_value">0.50</span>
                    </div>
                    <div id="speech_recognition_min_duration_div" title="Set minimum recording duration to avoid processing very short recordings. Recordings shorter than this will be ignored.">
                        <span>Minimum Recording Duration</span> </br>
                        <input type="range" id="speech_recognition_min_duration" min="100" max="5000" step="100" value="500" class="text_pole">
                        <span id="speech_recognition_min_duration_value">500ms</span>
                    </div>
                    <div id="speech_recognition_post_processing_div" title="Configure text post-processing options.">
                        <span>Text Replacements</span>
                        <textarea id="speech_recognition_text_replacements" class="text_pole textarea_compact" type="text" rows="3" placeholder="Enter text replacements, one per line:\nfind text = replace with\nNoah = Nova\n[remove this] = "></textarea>
                        <small style="opacity: 0.7;">Format: "find = replace" (leave replacement empty to remove)</small>
                    </div>
                    <div id="speech_recognition_message_mode_div">
                        <span>Message Mode</span> </br>
                        <select id="speech_recognition_message_mode">
                            <option value="append">Append</option>
                            <option value="replace">Replace</option>
                            <option value="auto_send">Auto send</option>
                        </select>
                    </div>
                    <div id="speech_recognition_message_mapping_div">
                        <span>Message Mapping</span>
                        <textarea id="speech_recognition_message_mapping" class="text_pole textarea_compact" type="text" rows="4" placeholder="Enter comma separated phrases mapping, example:\ncommand delete = /del 2,\nslash delete = /del 2,\nsystem roll = /roll 2d6,\nhey continue = /continue"></textarea>
                        <span id="speech_recognition_message_mapping_status"></span>
                        <label class="checkbox_label" for="speech_recognition_message_mapping_enabled">
                            <input type="checkbox" id="speech_recognition_message_mapping_enabled" name="speech_recognition_message_mapping_enabled">
                            <small>Enable messages mapping</small>
                        </label>
                    </div>
                    <form id="speech_recognition_provider_settings">
                    </form>
                </div>
            </div>
        </div>
        `;
        const getContainer = () => $(document.getElementById('stt_container') ?? document.getElementById('extensions_settings'));
        getContainer().append(settingsHtml);
        $('#speech_recognition_provider_settings').on('input', onSttProviderSettingsInput);
        for (const provider in sttProviders) {
            $('#speech_recognition_provider').append($('<option />').val(provider).text(provider));
            console.debug(DEBUG_PREFIX + 'added option ' + provider);
        }
        $('#speech_recognition_provider').on('change', onSttProviderChange);
        $('#speech_recognition_message_mode').on('change', onMessageModeChange);
        $('#speech_recognition_message_mapping').on('change', onMessageMappingChange);
        $('#speech_recognition_language').on('change', onSttLanguageChange);
        $('#speech_recognition_message_mapping_enabled').on('click', onMessageMappingEnabledClick);
        $('#speech_recognition_voice_activation_enabled').on('change', onVoiceActivationEnabledChange);
        $('#speech_recognition_adaptive_vad').on('change', onAdaptiveVadChange);
        $('#speech_recognition_vad_sensitivity').on('input', onVadSensitivityChange);
        $('#speech_recognition_min_duration').on('input', onMinRecordingDurationChange);
        $('#speech_recognition_remove_brackets').on('change', onRemoveBracketsChange);
        $('#speech_recognition_text_replacements').on('change', onTextReplacementsChange);
        $('#speech_recognition_ptt').on('focus', function () {
            if (this instanceof HTMLInputElement) {
                this.value = 'Enter a key combo. "Escape" to clear';
                $(this).off('keydown').on('keydown', function (e) {
                    e.preventDefault();
                    e.stopPropagation();

                    if (e.key === 'Meta' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control') {
                        return;
                    }

                    if (e.key === 'Escape') {
                        extension_settings.speech_recognition.ptt = null;
                        saveSettingsDebounced();
                        return this.blur();
                    }

                    const keyCombo = keyboardEventToKeyCombo(e);
                    extension_settings.speech_recognition.ptt = keyCombo;
                    saveSettingsDebounced();
                    return this.blur();
                });
            }
        });
        $('#speech_recognition_ptt').on('blur', function () {
            if (this instanceof HTMLInputElement) {
                $(this).off('keydown');
                if (extension_settings.speech_recognition.ptt) {
                    this.value = formatPushToTalkKey(extension_settings.speech_recognition.ptt);
                } else {
                    this.value = '';
                }
            }
        });

        document.body.addEventListener('keydown', processPushToTalkStart);
        document.body.addEventListener('keyup', processPushToTalkEnd);

        const $button = $('<div id="microphone_button" class="fa-solid fa-microphone speech-toggle interactable" tabindex="0" title="Click to speak"></div>');
        // For versions before 1.10.10
        if ($('#send_but_sheld').length == 0) {
            $('#rightSendForm').prepend($button);
        } else {
            $('#send_but_sheld').prepend($button);
        }

    }
    addExtensionControls(); // No init dependencies
    loadSettings(); // Depends on Extension Controls and loadTtsProvider
    loadSttProvider(extension_settings.speech_recognition.currentProvider); // No dependencies
    const wrapper = new ModuleWorkerWrapper(moduleWorker);
    setInterval(wrapper.update.bind(wrapper), UPDATE_INTERVAL); // Init depends on all the things
    moduleWorker();
});
