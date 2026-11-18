import React, { useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckCheck,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Languages,
  Lock,
  Mic,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Sticker,
  Upload,
  Volume2,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import { renderSvgToPngFile } from '../lib/mediaUtils';
import type { AIAssistResponse, Sticker3DItem, UserProfile } from '../lib/types';

interface AIAssistantViewProps {
  token: string;
  user?: UserProfile;
  onUserRefresh?: () => Promise<void>;
  consentGranted: boolean;
  onConsentChange: (granted: boolean) => void;
  activeRoomTitle?: string;
  recentDecryptedSnippets: string[];
  onInsertReplyToChat?: (text: string) => void;
}

type AITab =
  | 'personal_assistant'
  | 'voice_assistant'
  | 'smart_replies'
  | 'rewrite'
  | 'grammar'
  | 'translate'
  | 'summary'
  | 'voice'
  | 'spam_check'
  | 'image_spec'
  | 'sticker_spec';

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({
  token,
  user,
  onUserRefresh,
  consentGranted,
  onConsentChange,
  activeRoomTitle,
  recentDecryptedSnippets,
  onInsertReplyToChat,
}) => {
  const [tab, setTab] = useState<AITab>('personal_assistant');
  const [inputText, setInputText] = useState('');
  const [targetLang, setTargetLang] = useState('Nepali');
  const [tone, setTone] = useState('clear and concise');
  const [voiceName, setVoiceName] = useState('Kore');
  const [outputText, setOutputText] = useState<string>('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [audioDataUrl, setAudioDataUrl] = useState<string | null>(null);
  const [grammarResult, setGrammarResult] = useState<AIAssistResponse['grammar'] | null>(null);
  const [spamReport, setSpamReport] = useState<AIAssistResponse['spamReport'] | null>(null);
  const [generatedArt, setGeneratedArt] = useState<AIAssistResponse['generatedArt'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Voice-to-text recording state
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  function resetOutputs() {
    setError(null);
    setStatus(null);
    setOutputText('');
    setSuggestions([]);
    setAudioDataUrl(null);
    setGrammarResult(null);
    setSpamReport(null);
    setGeneratedArt(null);
  }

  async function runAssistant() {
    resetOutputs();
    setBusy(true);
    try {
      if (tab === 'summary') {
        const lines = inputText.trim()
          ? inputText.split('\n').filter(Boolean)
          : recentDecryptedSnippets;
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'summary',
          messages: lines,
        });
        setOutputText(res.resultText ?? res.text ?? '');
      } else if (tab === 'smart_replies') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'smart_replies',
          text: inputText.trim() || undefined,
          messages: recentDecryptedSnippets,
        });
        setSuggestions(res.suggestions ?? []);
        if (res.resultText || res.text) setOutputText(res.resultText ?? res.text ?? '');
      } else if (tab === 'translate') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'translate',
          text: inputText.trim(),
          targetLang,
        });
        setOutputText(res.resultText ?? res.text ?? '');
      } else if (tab === 'rewrite') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'rewrite',
          text: inputText.trim(),
          tone,
        });
        setOutputText(res.resultText ?? res.text ?? '');
      } else if (tab === 'personal_assistant') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'personal_assistant',
          text: inputText.trim(),
        });
        setOutputText(res.resultText ?? res.text ?? '');
      } else if (tab === 'voice_assistant') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'voice_assistant',
          text: inputText.trim(),
          voiceName,
        });
        setOutputText(res.resultText ?? res.text ?? '');
        if (res.audioDataUrl) setAudioDataUrl(res.audioDataUrl);
      } else if (tab === 'grammar') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'grammar',
          text: inputText.trim(),
        });
        setGrammarResult(res.grammar ?? null);
        setOutputText(res.grammar?.correctedText ?? res.resultText ?? '');
      } else if (tab === 'spam_check') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: 'spam_check',
          text: inputText.trim(),
        });
        setSpamReport(res.spamReport ?? null);
      } else if (tab === 'image_spec' || tab === 'sticker_spec') {
        const res = await rrApi.aiAssist(token, {
          consentGranted,
          mode: tab,
          text: inputText.trim(),
        });
        setGeneratedArt(res.generatedArt ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'RR AI Brain request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTranscribeBlob(blob: Blob, mimeType: string) {
    resetOutputs();
    setBusy(true);
    try {
      const arrayBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const base64 = btoa(bin);
      const res = await rrApi.aiTranscribe(token, {
        consentGranted,
        audioBase64: base64,
        mimeType: mimeType || 'audio/webm',
      });
      setOutputText(res.transcript);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice-to-text transcription failed.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    if (recording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecording(false);
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' });
        handleTranscribeBlob(blob, mr.mimeType || 'audio/webm');
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch {
      setError('Microphone access is blocked. You can upload an audio clip instead.');
    }
  }

  async function handleSaveGeneratedSticker() {
    if (!generatedArt || !user) return;
    const newSticker: Sticker3DItem = {
      id: `ai-stk-${Date.now()}`,
      name: generatedArt.title.slice(0, 28),
      shape: generatedArt.shape ?? 'prism',
      color: /^#[0-9a-fA-F]{6}$/.test(generatedArt.color ?? '') ? generatedArt.color! : '#A855F7',
      glowColor: /^#[0-9a-fA-F]{6}$/.test(generatedArt.glowColor ?? '') ? generatedArt.glowColor! : '#E2E8F0',
      animation: 'orbit',
      label: (generatedArt.label || 'AI 3D').slice(0, 18),
      createdAt: Date.now(),
    };
    const nextPack = [newSticker, ...(user.stickerPack ?? [])].slice(0, 24);
    await rrApi.saveStickers(token, nextPack);
    await onUserRefresh?.();
    setStatus(`Saved "${newSticker.name}" into your 3D Sticker Pack.`);
  }

  async function handleDownloadArtPng() {
    if (!generatedArt) return;
    const file = await renderSvgToPngFile(generatedArt.svgMarkup, `${generatedArt.title.replace(/\W+/g, '_')}.png`);
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
              <Bot className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              RR AI Brain
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              10 opt-in AI modules: Personal &amp; Voice Assistant, Message Writer, Grammar Checker, Nepali/Global
              Translator, Conversation Summary, Voice-to-Text, Spam Detector, and Vector Art &amp; 3D Sticker Studio.
            </p>
          </div>
        </div>

        {/* Explicit Opt-In Consent Gate */}
        <div
          className={`rounded-2xl border p-5 space-y-3 ${
            consentGranted
              ? 'bg-purple-50/70 dark:bg-purple-950/25 border-purple-300 dark:border-purple-800/70'
              : 'rr-glass border-zinc-200 dark:border-zinc-800'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              {consentGranted ? (
                <Sparkles className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
              ) : (
                <Lock className="w-5 h-5 text-zinc-500 shrink-0 mt-0.5" />
              )}
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Zero-Auto-Sharing Privacy Consent
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 leading-relaxed">
                  End-to-end encrypted conversations are decrypted strictly on your device. RR AI Brain is disabled
                  by default and NEVER sends message text or audio unless you explicitly opt in below.
                </p>
              </div>
            </div>
            <label className="inline-flex items-center gap-2.5 cursor-pointer shrink-0 px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <input
                type="checkbox"
                checked={consentGranted}
                onChange={(e) => onConsentChange(e.target.checked)}
                className="w-4 h-4 accent-purple-600"
              />
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                {consentGranted ? 'AI Processing Enabled' : 'Enable Opt-In AI'}
              </span>
            </label>
          </div>
        </div>

        {status && (
          <div className="p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-xs text-purple-900 dark:text-purple-200">
            {status}
          </div>
        )}
        {error && (
          <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/70 text-red-800 dark:text-red-200 text-xs flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* 10+ Mode Selector */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: 'personal_assistant', label: 'Personal Assistant', icon: Bot },
              { id: 'voice_assistant', label: 'AI Voice Assistant', icon: Volume2 },
              { id: 'smart_replies', label: 'Smart Replies', icon: Sparkles },
              { id: 'rewrite', label: 'Message Writer', icon: FileText },
              { id: 'grammar', label: 'Grammar Checker', icon: CheckCheck },
              { id: 'translate', label: 'Translator (नेपाली/Global)', icon: Languages },
              { id: 'summary', label: 'Chat Summary', icon: FileText },
              { id: 'voice', label: 'Voice-to-Text', icon: Mic },
              { id: 'spam_check', label: 'Spam & Scam Check', icon: ShieldCheck },
              { id: 'image_spec', label: 'AI Vector Image', icon: ImageIcon },
              { id: 'sticker_spec', label: 'AI 3D Sticker Gen', icon: Sticker },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  resetOutputs();
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border whitespace-nowrap ${
                  tab === item.id
                    ? 'bg-purple-600 text-white border-purple-500'
                    : 'rr-glass border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-purple-500/50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Workspace Card */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
          {tab === 'voice' ? (
            <div className="space-y-4">
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Record a short voice clip or upload an audio file to transcribe into text using Gemini transcription.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={!consentGranted || busy}
                  onClick={toggleRecording}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold text-white whitespace-nowrap disabled:opacity-50 ${
                    recording ? 'bg-red-600 hover:bg-red-500' : 'bg-purple-600 hover:bg-purple-500'
                  }`}
                >
                  {recording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                  {recording ? 'Stop & Transcribe' : 'Record Voice Note'}
                </button>
                <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 cursor-pointer hover:border-purple-500/50">
                  <Upload className="w-3.5 h-3.5" />
                  Upload Audio File
                  <input
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    disabled={!consentGranted || busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleTranscribeBlob(f, f.type);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {(tab === 'smart_replies' || tab === 'summary') && (
                <div className="text-xs text-zinc-600 dark:text-zinc-400">
                  Active Chat Context:{' '}
                  <strong className="text-zinc-900 dark:text-zinc-100">{activeRoomTitle || 'No room selected'}</strong>{' '}
                  ({recentDecryptedSnippets.length} decrypted snippets available locally)
                </div>
              )}

              {tab === 'translate' && (
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Target Language</label>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100"
                  >
                    {['Nepali', 'English', 'Hindi', 'Japanese', 'Spanish', 'French', 'German', 'Arabic'].map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {tab === 'voice_assistant' && (
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Assistant Voice</label>
                  <select
                    value={voiceName}
                    onChange={(e) => setVoiceName(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100"
                  >
                    {['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {tab === 'rewrite' && (
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Writing Style</label>
                  <select
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100"
                  >
                    <option value="clear and concise">Clear &amp; Concise</option>
                    <option value="professional">Formal / Executive</option>
                    <option value="warm and friendly">Warm &amp; Friendly</option>
                    <option value="brief">Ultra-Brief</option>
                  </select>
                </div>
              )}

              <textarea
                rows={4}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={
                  tab === 'summary'
                    ? 'Leave blank to summarize the active decrypted chat, or paste lines here...'
                    : tab === 'image_spec' || tab === 'sticker_spec'
                      ? 'Describe your futuristic vector artwork or 3D sticker badge (e.g. Cyber purple Everest shield)...'
                      : tab === 'spam_check'
                        ? 'Paste a suspicious message or URL to analyze phishing/scam risk...'
                        : 'Type or paste message text (Nepali or English supported)...'
                }
                className="w-full px-4 py-3 rounded-xl bg-white dark:bg-zinc-950/80 border border-zinc-200 dark:border-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-purple-500"
              />

              <button
                type="button"
                disabled={!consentGranted || busy}
                onClick={runAssistant}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {busy ? 'Processing via Gemini...' : 'Run RR AI Brain'}
              </button>
            </div>
          )}

          {/* Voice Assistant Audio Player */}
          {audioDataUrl && (
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
              <div className="text-xs font-semibold text-purple-600 dark:text-purple-400">Synthesized Voice Response</div>
              <audio controls autoPlay src={audioDataUrl} className="w-full max-w-md" />
            </div>
          )}

          {/* Grammar Issues Breakdown */}
          {grammarResult && (
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
              <div className="text-xs font-semibold text-zinc-500">Grammar &amp; Clarity Corrections</div>
              {grammarResult.issues.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-300 space-y-1">
                  {grammarResult.issues.map((iss, idx) => (
                    <li key={idx}>{iss}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Spam / Phishing Report */}
          {spamReport && (
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Risk Assessment: {spamReport.riskLevel.toUpperCase()}</span>
                <span className="font-mono text-xs tabular-nums">Threat Score: {spamReport.score}/100</span>
              </div>
              {spamReport.reasons.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
                  {spamReport.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-purple-600 dark:text-purple-400">{spamReport.advice}</p>
            </div>
          )}

          {/* Generated Vector Image / 3D Sticker */}
          {generatedArt && (
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">{generatedArt.title}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadArtPng}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download PNG
                  </button>
                  {user && (
                    <button
                      type="button"
                      onClick={handleSaveGeneratedSticker}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold"
                    >
                      <Sticker className="w-3.5 h-3.5" />
                      Save to 3D Sticker Pack
                    </button>
                  )}
                </div>
              </div>
              <div
                className="w-56 h-56 rounded-2xl overflow-hidden border border-purple-500/40 bg-[#090B12] flex items-center justify-center p-2"
                dangerouslySetInnerHTML={{ __html: generatedArt.svgMarkup }}
              />
            </div>
          )}

          {/* Suggested Replies */}
          {suggestions.length > 0 && (
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
              <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Suggested Replies</div>
              <div className="space-y-2">
                {suggestions.map((s, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3"
                  >
                    <span className="text-sm text-zinc-900 dark:text-zinc-100">{s}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(s).catch(() => {});
                          setCopiedIdx(idx);
                          setTimeout(() => setCopiedIdx(null), 1500);
                        }}
                        className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                        title="Copy"
                      >
                        {copiedIdx === idx ? <Check className="w-3.5 h-3.5 text-purple-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      {onInsertReplyToChat && (
                        <button
                          type="button"
                          onClick={() => onInsertReplyToChat(s)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium"
                        >
                          <Send className="w-3 h-3" />
                          Use
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {outputText && (
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Assistant Output</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(outputText).catch(() => {})}
                    className="inline-flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    <Copy className="w-3 h-3" />
                    Copy
                  </button>
                  {onInsertReplyToChat && (
                    <button
                      type="button"
                      onClick={() => onInsertReplyToChat(outputText)}
                      className="inline-flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:underline"
                    >
                      <Send className="w-3 h-3" />
                      Send to Active Chat
                    </button>
                  )}
                </div>
              </div>
              <div className="p-4 rounded-xl bg-white dark:bg-zinc-950/90 border border-zinc-200 dark:border-zinc-800 text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap leading-relaxed">
                {outputText}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
