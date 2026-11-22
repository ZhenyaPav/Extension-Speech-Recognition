# Extension-Speech-Recognition

Convert your speech to text using one of the supported sources.

- Browser (Web Speech API)
- Whisper (OpenAI API)
- OpenAI-compatible transcription servers, including audio.cpp
- Voxtral (MistralAI API)
- GLM ASR (Z.AI API)
- KoboldCpp
- Groq
- Chutes
- and others...

Documentation: <https://docs.sillytavern.app/extensions/speech-recognition/>

For a custom server, select **OpenAI Compatible**, enter the full transcription endpoint URL and model ID, and optionally enter an API key. For audio.cpp, the URL is typically `http://127.0.0.1:8080/v1/audio/transcriptions`; use the model ID configured on your server. The browser connects directly, so the server must permit SillyTavern's origin via CORS, and localhost refers to the browser's machine. The optional key is kept only until the provider is switched or the page is reloaded. Audio is sent after recording stops; the live transcription endpoint is not supported.

## License and credits

GPLv3

vad.js by [kdavis-mozilla](https://github.com/kdavis-mozilla) is from <https://github.com/kdavis-mozilla/vad.js> (BSD-3-Clause).
