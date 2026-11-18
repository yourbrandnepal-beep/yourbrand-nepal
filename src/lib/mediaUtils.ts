export type VoiceEffectId = 'natural' | 'deep' | 'helium' | 'robot' | 'echo';

export const VOICE_EFFECTS: Array<{ id: VoiceEffectId; label: string }> = [
  { id: 'natural', label: 'Natural' },
  { id: 'deep', label: 'Deep Bass' },
  { id: 'helium', label: 'Helium' },
  { id: 'robot', label: 'Cyber Robot' },
  { id: 'echo', label: 'Studio Echo' },
];

function encodeWavFromAudioBuffer(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const dataLength = length * numChannels * 2;
  const wav = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wav);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return wav;
}

export async function applyVoiceEffectToBlob(blob: Blob, effect: VoiceEffectId): Promise<File> {
  if (effect === 'natural') {
    return new File([blob], `voice-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
  }
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const decodeCtx = new AudioCtx();
    const rawBuf = await blob.arrayBuffer();
    const decoded = await decodeCtx.decodeAudioData(rawBuf);
    await decodeCtx.close().catch(() => {});

    const rate = effect === 'deep' ? 0.78 : effect === 'helium' ? 1.32 : 1.0;
    const extraTailSeconds = effect === 'echo' ? 0.45 : 0;
    const outFrames = Math.max(1, Math.ceil((decoded.length / rate) + extraTailSeconds * decoded.sampleRate));
    const offline = new OfflineAudioContext(decoded.numberOfChannels, outFrames, decoded.sampleRate);

    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.playbackRate.value = rate;

    if (effect === 'robot') {
      const osc = offline.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 52;
      const modGain = offline.createGain();
      modGain.gain.value = 0.55;
      const mainGain = offline.createGain();
      mainGain.gain.value = 0.7;
      const bandpass = offline.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1150;
      bandpass.Q.value = 1.6;
      src.connect(bandpass);
      bandpass.connect(mainGain);
      osc.connect(modGain);
      modGain.connect(mainGain.gain);
      mainGain.connect(offline.destination);
      osc.start(0);
    } else if (effect === 'echo') {
      const delay = offline.createDelay(1.0);
      delay.delayTime.value = 0.22;
      const fb = offline.createGain();
      fb.gain.value = 0.36;
      src.connect(offline.destination);
      src.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(offline.destination);
    } else if (effect === 'deep') {
      const low = offline.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 260;
      low.gain.value = 7;
      src.connect(low);
      low.connect(offline.destination);
    } else {
      const high = offline.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 1800;
      high.gain.value = 5;
      src.connect(high);
      high.connect(offline.destination);
    }

    src.start(0);
    const rendered = await offline.startRendering();
    const wavBuf = encodeWavFromAudioBuffer(rendered);
    return new File([wavBuf], `voice-${effect}-${Date.now()}.wav`, { type: 'audio/wav' });
  } catch {
    return new File([blob], `voice-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
  }
}

export function playNotificationChime(style: 'crystal' | 'pulse' | 'chime' | 'silent' = 'crystal') {
  if (style === 'silent') return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes =
      style === 'crystal'
        ? [880, 1318.5]
        : style === 'pulse'
          ? [523.25, 659.25]
          : [587.33, 783.99, 1046.5];

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = style === 'pulse' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      gain.gain.setValueAtTime(0.001, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.09, now + idx * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.24);
    });
    window.setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

export interface ScannedUrlFinding {
  url: string;
  risk: 'safe' | 'suspicious';
  reasons: string[];
}

export function scanTextForSuspiciousUrls(text: string): ScannedUrlFinding[] {
  const regex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;
  const matches = text.match(regex) ?? [];
  const findings: ScannedUrlFinding[] = [];
  const seen = new Set<string>();

  for (const rawUrl of matches) {
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);
    const reasons: string[] = [];
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol === 'http:') reasons.push('Unencrypted HTTP link (no TLS)');
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) reasons.push('Direct IP address instead of verified domain');
      if (host.includes('xn--')) reasons.push('Punycode / homograph domain detected');
      if (rawUrl.includes('@')) reasons.push('Contains @ credential redirect trick');
      if (/\.(zip|mov|tk|ml|ga|cf|gq|ru|top|xyz|click|work)$/i.test(host)) {
        reasons.push('High-risk phishing TLD pattern');
      }
      if (/login|verify|wallet|claim|airdrop|seed|password|unlock/i.test(parsed.pathname + host)) {
        reasons.push('Contains credential-harvesting keywords');
      }
    } catch {
      reasons.push('Malformed URL syntax');
    }
    findings.push({
      url: rawUrl,
      risk: reasons.length > 0 ? 'suspicious' : 'safe',
      reasons,
    });
  }
  return findings;
}

export async function renderSvgToPngFile(svgMarkup: string, filename = 'rrchat-art.png'): Promise<File> {
  const safeSvg = svgMarkup
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+=/gi, '');
  const svgBlob = new Blob([safeSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to render SVG image.'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#090B12';
      ctx.fillRect(0, 0, 512, 512);
      ctx.drawImage(img, 0, 0, 512, 512);
    }
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
    });
    return new File([pngBlob], filename, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
