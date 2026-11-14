// Monaco's base editor worker (diff computation, word ranges, links), bundled from the local
// monaco-editor package and served from our own origin: no CDN, CSP-friendly. The languages we
// use (powershell, shell, bat, markdown, plaintext) are Monarch tokenizers that need no
// language-specific worker.
import 'monaco-editor/editor/editor.worker';
