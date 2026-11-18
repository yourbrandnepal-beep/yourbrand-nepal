import React, { useCallback, useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RecordPlugin from 'wavesurfer.js/plugins/record';
import {
  Check,
  Lock,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  applyVoiceEffectToBlob,
  VOICE_EFFECTS,
  type VoiceEffectId,
} from '../lib/mediaUtils';

export function formatVoiceDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = String(safe % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function selectPreferredAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

interface VoiceMessageRecorderProps {
  sending: boolean;
  voiceEffect: VoiceEffectId;
  onVoiceEffectChange: (effect: VoiceEffectId) => void;
  onSendVoice: (file: File, durationSec: number, effect: VoiceEffectId) => Promise<void>;
  onClose: () => void;
}

type RecorderPhase = 'idle' | 'recording' | 'paused' | 'review';

export const VoiceMessageRecorder: React.FC<VoiceMessageRecorderProps> = ({
  sending,
  voiceEffect,
  onVoiceEffectChange,
  onSendVoice,
  onClose,
}) => {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [rawBlob, setRawBlob] = useState<Blob | null>(null);
  const [processedFile, setProcessedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processingEffect, setProcessingEffect] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  const liveWaveContainerRef = useRef<HTMLDivElement | null>(null);
  const previewWaveContainerRef = useRef<HTMLDivElement | null>(null);
  const recordWsRef = useRef<WaveSurfer | null>(null);
  const recordPluginRef = useRef<RecordPlugin | null>(null);
  const previewWsRef = useRef<WaveSurfer | null>(null);
  const sendImmediatelyRef = useRef(false);
  const latestDurationRef = useRef(0);
  const latestEffectRef = useRef<VoiceEffectId>(voiceEffect);
  const discardedRef = useRef(false);

  useEffect(() => {
    latestEffectRef.current = voiceEffect;
  }, [voiceEffect]);

  // Enumerate microphones cleanly
  const refreshAudioDevices = useCallback(async () => {
    try {
      const list = await RecordPlugin.getAvailableAudioDevices();
      setDevices(list);
      if (list.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(list[0].deviceId);
      }
    } catch {
      // Ignore if MediaDevices API is unavailable
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    refreshAudioDevices();
  }, [refreshAudioDevices]);

  // Initialize WaveSurfer + RecordPlugin when in idle/recording/paused phases
  useEffect(() => {
    if (phase === 'review') return;
    const container = liveWaveContainerRef.current;
    if (!container) return;

    const ws = WaveSurfer.create({
      container,
      waveColor: '#a855f7',
      progressColor: '#c084fc',
      cursorWidth: 0,
      height: 44,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      interact: false,
    });

    const preferredMime = selectPreferredAudioMimeType();
    const record = ws.registerPlugin(
      RecordPlugin.create({
        mimeType: preferredMime,
        audioBitsPerSecond: 128000,
        renderRecordedAudio: false,
        scrollingWaveform: false,
        continuousWaveform: true,
        continuousWaveformDuration: 30,
      })
    );

    const unsubProgress = record.on('record-progress', (durationMs: number) => {
      const secs = durationMs / 1000;
      latestDurationRef.current = secs;
      setElapsedSec(secs);
    });

    const unsubEnd = record.on('record-end', async (blob: Blob) => {
      if (discardedRef.current) {
        discardedRef.current = false;
        return;
      }
      if (!blob || blob.size === 0) {
        setMicError('No audio captured from microphone.');
        setPhase('idle');
        return;
      }

      const finalDuration = Math.max(1, Math.round(latestDurationRef.current));
      setRawBlob(blob);

      if (sendImmediatelyRef.current) {
        sendImmediatelyRef.current = false;
        setProcessingEffect(true);
        try {
          const prepared = await applyVoiceEffectToBlob(blob, latestEffectRef.current);
          await onSendVoice(prepared, finalDuration, latestEffectRef.current);
        } catch (err) {
          setMicError(err instanceof Error ? err.message : 'Failed to encrypt and send voice message.');
          setPhase('review');
        } finally {
          setProcessingEffect(false);
        }
      } else {
        setPhase('review');
      }
    });

    recordWsRef.current = ws;
    recordPluginRef.current = record;

    return () => {
      unsubProgress();
      unsubEnd();
      try {
        if (record.isRecording() || record.isPaused()) {
          discardedRef.current = true;
          record.stopRecording();
        }
        record.stopMic();
      } catch {
        // ignore cleanup errors
      }
      ws.destroy();
      recordWsRef.current = null;
      recordPluginRef.current = null;
    };
  }, [phase === 'review']);

  // Process raw recorded Blob through selected voice effect and create preview URL
  useEffect(() => {
    if (phase !== 'review' || !rawBlob) return;
    let cancelled = false;
    let createdUrl: string | null = null;

    setProcessingEffect(true);
    applyVoiceEffectToBlob(rawBlob, voiceEffect)
      .then((file) => {
        if (cancelled) return;
        setProcessedFile(file);
        createdUrl = URL.createObjectURL(file);
        setPreviewUrl(createdUrl);
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = new File([rawBlob], `voice-${Date.now()}.webm`, {
          type: rawBlob.type || 'audio/webm',
        });
        setProcessedFile(fallback);
        createdUrl = URL.createObjectURL(fallback);
        setPreviewUrl(createdUrl);
      })
      .finally(() => {
        if (!cancelled) setProcessingEffect(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [phase, rawBlob, voiceEffect]);

  // Mount interactive WaveSurfer preview player when in review phase
  useEffect(() => {
    if (phase !== 'review' || !previewUrl || !previewWaveContainerRef.current) return;

    const ws = WaveSurfer.create({
      container: previewWaveContainerRef.current,
      url: previewUrl,
      waveColor: 'rgba(161, 161, 170, 0.45)',
      progressColor: '#a855f7',
      cursorColor: '#c084fc',
      height: 40,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
    });

    ws.on('ready', (dur) => {
      setPreviewDuration(dur);
      setPreviewTime(0);
    });
    ws.on('timeupdate', (t) => setPreviewTime(t));
    ws.on('play', () => setPreviewPlaying(true));
    ws.on('pause', () => setPreviewPlaying(false));
    ws.on('finish', () => setPreviewPlaying(false));

    previewWsRef.current = ws;
    return () => {
      ws.destroy();
      previewWsRef.current = null;
      setPreviewPlaying(false);
    };
  }, [phase, previewUrl]);

  async function handleStartRecording() {
    const plugin = recordPluginRef.current;
    if (!plugin) return;
    setMicError(null);
    discardedRef.current = false;
    sendImmediatelyRef.current = false;
    latestDurationRef.current = 0;
    setElapsedSec(0);
    setRawBlob(null);
    setProcessedFile(null);
    setPreviewUrl(null);

    try {
      await plugin.startRecording(
        selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : undefined
      );
      setPhase('recording');
      refreshAudioDevices();
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow microphone permission in your browser settings.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No microphone device detected.'
            : 'Could not start microphone recording.';
      setMicError(msg);
      setPhase('idle');
    }
  }

  function handlePauseResume() {
    const plugin = recordPluginRef.current;
    if (!plugin) return;
    if (plugin.isPaused()) {
      plugin.resumeRecording();
      setPhase('recording');
    } else if (plugin.isRecording()) {
      plugin.pauseRecording();
      setPhase('paused');
    }
  }

  function handleStopForReview() {
    const plugin = recordPluginRef.current;
    if (!plugin || (!plugin.isRecording() && !plugin.isPaused())) return;
    sendImmediatelyRef.current = false;
    plugin.stopRecording();
    plugin.stopMic();
  }

  function handleStopAndSendNow() {
    const plugin = recordPluginRef.current;
    if (!plugin || (!plugin.isRecording() && !plugin.isPaused())) return;
    sendImmediatelyRef.current = true;
    plugin.stopRecording();
    plugin.stopMic();
  }

  function handleDiscard() {
    const plugin = recordPluginRef.current;
    if (plugin && (plugin.isRecording() || plugin.isPaused())) {
      discardedRef.current = true;
      plugin.stopRecording();
      plugin.stopMic();
    }
    setRawBlob(null);
    setProcessedFile(null);
    setPreviewUrl(null);
    setElapsedSec(0);
    setPhase('idle');
    onClose();
  }

  function handleReRecord() {
    setRawBlob(null);
    setProcessedFile(null);
    setPreviewUrl(null);
    setElapsedSec(0);
    setPhase('idle');
  }

  async function handleConfirmSend() {
    if (!processedFile) return;
    setMicError(null);
    const dur = Math.max(1, Math.round(previewDuration || latestDurationRef.current));
    try {
      await onSendVoice(processedFile, dur, voiceEffect);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : 'Failed to encrypt and send voice message.');
    }
  }

  return (
    <div className="p-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <Mic className={`w-4 h-4 ${phase === 'recording' ? 'text-red-500' : 'text-purple-500'}`} />
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">Encrypted Voice Message</span>
          <span aria-hidden="true" className="text-zinc-400">·</span>
          <span className="font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
            {phase === 'review'
              ? `${formatVoiceDuration(previewTime)} / ${formatVoiceDuration(previewDuration || elapsedSec)}`
              : formatVoiceDuration(elapsedSec)}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {devices.length > 1 && phase === 'idle' && (
            <select
              aria-label="Select microphone input"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className="max-w-[180px] px-2.5 py-1.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-700 dark:text-zinc-300"
            >
              {devices.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `Microphone ${idx + 1}`}
                </option>
              ))}
            </select>
          )}

          <select
            aria-label="Voice effect"
            value={voiceEffect}
            disabled={processingEffect || sending}
            onChange={(e) => onVoiceEffectChange(e.target.value as VoiceEffectId)}
            className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-700 dark:text-zinc-300"
          >
            {VOICE_EFFECTS.map((ve) => (
              <option key={ve.id} value={ve.id}>
                {ve.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleDiscard}
            disabled={sending}
            className="p-1.5 rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-red-500 hover:border-red-500/40 transition-colors"
            title="Cancel and discard voice note"
            aria-label="Cancel voice recording"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {micError && (
        <p className="text-xs text-red-500 dark:text-red-400">{micError}</p>
      )}

      {/* Live Waveform or Review Waveform */}
      {phase !== 'review' ? (
        <div className="px-3 py-2 rounded-xl bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800/80 flex items-center gap-3">
          <div ref={liveWaveContainerRef} className="flex-1 min-w-0 min-h-[44px]" />
          {phase === 'idle' && (
            <span className="text-xs text-zinc-400 shrink-0">Ready to capture microphone</span>
          )}
        </div>
      ) : (
        <div className="px-3 py-2 rounded-xl bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800/80 flex items-center gap-3">
          <button
            type="button"
            disabled={processingEffect || !previewWsRef.current}
            onClick={() => previewWsRef.current?.playPause()}
            className="w-9 h-9 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white flex items-center justify-center shrink-0"
            aria-label={previewPlaying ? 'Pause voice preview' : 'Play voice preview'}
          >
            {previewPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <div ref={previewWaveContainerRef} className="flex-1 min-w-0 min-h-[40px]" />
          {processingEffect && (
            <span className="text-xs text-purple-500 shrink-0">Applying effect...</span>
          )}
        </div>
      )}

      {/* Action Controls */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          <Lock className="w-3 h-3 text-purple-500" />
          <span>Encrypted locally with AES-256-GCM before upload</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {phase === 'idle' && (
            <button
              type="button"
              onClick={handleStartRecording}
              disabled={sending}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold whitespace-nowrap"
            >
              <Mic className="w-3.5 h-3.5" />
              Start Recording
            </button>
          )}

          {(phase === 'recording' || phase === 'paused') && (
            <>
              <button
                type="button"
                onClick={handlePauseResume}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-800 dark:text-zinc-200 whitespace-nowrap"
              >
                {phase === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                {phase === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                onClick={handleStopForReview}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-800 dark:text-zinc-200 whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" />
                Review
              </button>
              <button
                type="button"
                onClick={handleStopAndSendNow}
                disabled={sending || processingEffect}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" />
                Encrypt &amp; Send
              </button>
            </>
          )}

          {phase === 'review' && (
            <>
              <button
                type="button"
                onClick={handleReRecord}
                disabled={sending}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-800 dark:text-zinc-200 whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Re-record
              </button>
              <button
                type="button"
                onClick={handleConfirmSend}
                disabled={sending || processingEffect || !processedFile}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
              >
                <Check className="w-3.5 h-3.5" />
                {sending ? 'Encrypting & Sending...' : 'Encrypt & Send'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

interface EncryptedVoicePlayerProps {
  url: string;
  durationSec?: number;
  effect?: string;
  isMine: boolean;
}

export const EncryptedVoicePlayer: React.FC<EncryptedVoicePlayerProps> = ({
  url,
  durationSec,
  effect,
  isMine,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(durationSec ?? 0);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);
  const [decodeFailed, setDecodeFailed] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setDecodeFailed(false);
    const ws = WaveSurfer.create({
      container: el,
      url,
      waveColor: isMine ? 'rgba(192, 132, 252, 0.45)' : 'rgba(161, 161, 170, 0.45)',
      progressColor: '#a855f7',
      cursorColor: '#c084fc',
      height: 34,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
    });

    ws.on('ready', (dur) => {
      if (Number.isFinite(dur) && dur > 0) setTotalDuration(dur);
    });
    ws.on('timeupdate', (t) => setCurrentTime(t));
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => setPlaying(false));
    ws.on('finish', () => setPlaying(false));
    ws.on('error', () => setDecodeFailed(true));

    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
      setPlaying(false);
    };
  }, [url, isMine]);

  function cyclePlaybackSpeed() {
    const next: 1 | 1.5 | 2 = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    wsRef.current?.setPlaybackRate(next);
  }

  if (decodeFailed) {
    return <audio controls src={url} className="mt-2.5 max-w-full" />;
  }

  const effectLabel =
    effect && effect !== 'natural'
      ? VOICE_EFFECTS.find((v) => v.id === effect)?.label ?? effect
      : null;

  return (
    <div className="mt-2 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950/90 border border-zinc-200 dark:border-zinc-800 min-w-[230px] sm:min-w-[260px] space-y-1.5">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => wsRef.current?.playPause()}
          className="w-8 h-8 rounded-lg bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shrink-0 transition-colors"
          aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
        </button>

        <div ref={containerRef} className="flex-1 min-w-0 min-h-[34px]" />

        <button
          type="button"
          onClick={cyclePlaybackSpeed}
          className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 text-[11px] font-mono tabular-nums text-zinc-700 dark:text-zinc-300 hover:border-purple-500/60 shrink-0"
          title="Change playback speed"
        >
          {speed}x
        </button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400 font-mono tabular-nums px-0.5">
        <span className="inline-flex items-center gap-1">
          <Volume2 className="w-3 h-3 text-purple-500" />
          <span>{formatVoiceDuration(currentTime)}</span>
          <span aria-hidden="true">/</span>
          <span>{formatVoiceDuration(totalDuration)}</span>
        </span>
        {effectLabel && <span className="font-sans text-zinc-500 dark:text-zinc-400">{effectLabel}</span>}
      </div>
    </div>
  );
};
