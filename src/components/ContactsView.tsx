import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import {
  Ban,
  Camera,
  Check,
  CheckCircle2,
  Copy,
  Fingerprint,
  MessageSquarePlus,
  QrCode,
  ScanLine,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import { DeviceKeyVault, saveVaultToLocal } from '../lib/crypto';
import type { DirectoryUser, UserProfile } from '../lib/types';
import { BADGE_LABELS } from './Avatar3DStudio';

interface ContactsViewProps {
  token: string;
  user: UserProfile;
  deviceId: string;
  vault: DeviceKeyVault;
  onVaultUpdated: (vault: DeviceKeyVault) => void;
  onStartDirectChat: (user: DirectoryUser) => Promise<void>;
}

interface IdentityQrPayload {
  v: 'rrchat1-id-v1';
  userId: string;
  username: string;
  deviceId: string;
  fingerprint: string;
}

export const ContactsView: React.FC<ContactsViewProps> = ({
  token,
  user,
  deviceId,
  vault,
  onVaultUpdated,
  onStartDirectChat,
}) => {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<Array<{ id: string; username: string; displayName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<DirectoryUser | null>(null);
  const [reportReason, setReportReason] = useState('');

  const [showMyQrModal, setShowMyQrModal] = useState(false);
  const [myQrDataUrl, setMyQrDataUrl] = useState<string>('');
  const [copiedPayload, setCopiedPayload] = useState(false);

  const [showScannerModal, setShowScannerModal] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualPayload, setManualPayload] = useState('');
  const [scanResult, setScanResult] = useState<{
    ok: boolean;
    message: string;
    matchedUser?: DirectoryUser;
    fingerprint?: string;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const qrUploadInputRef = useRef<HTMLInputElement | null>(null);

  const myQrPayload: IdentityQrPayload = {
    v: 'rrchat1-id-v1',
    userId: user.id,
    username: user.username,
    deviceId,
    fingerprint: vault.fingerprint,
  };

  async function loadDirectory(q = query) {
    setLoading(true);
    try {
      const res = await rrApi.searchUsers(token, q);
      setUsers(res.users);
      setBlockedUsers(res.blockedUsers);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to search directory.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDirectory('');
  }, [token]);

  useEffect(() => {
    if (!showMyQrModal) return;
    QRCode.toDataURL(JSON.stringify(myQrPayload), {
      width: 260,
      margin: 2,
      color: { dark: '#09090B', light: '#F8FAFC' },
    })
      .then(setMyQrDataUrl)
      .catch(() => {});
  }, [showMyQrModal, user.id, deviceId, vault.fingerprint]);

  const stopCamera = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    if (!showScannerModal) {
      stopCamera();
      setScanResult(null);
      setCameraError(null);
      setManualPayload('');
    }
    return () => stopCamera();
  }, [showScannerModal]);

  async function verifyScannedQrString(rawText: string) {
    setCameraError(null);
    let parsed: IdentityQrPayload;
    try {
      parsed = JSON.parse(rawText.trim()) as IdentityQrPayload;
      if (parsed.v !== 'rrchat1-id-v1' || !parsed.userId || !parsed.deviceId || !parsed.fingerprint) {
        throw new Error('Invalid format');
      }
    } catch {
      setScanResult({
        ok: false,
        message: 'QR code is not a valid RRchat 1 device identity payload.',
      });
      return;
    }

    if (parsed.userId === user.id && parsed.deviceId === deviceId) {
      setScanResult({
        ok: true,
        message: 'Scanned your own current device identity QR code.',
        fingerprint: parsed.fingerprint,
      });
      return;
    }

    try {
      const res = await rrApi.searchUsers(token, '', parsed.userId);
      const target = res.users[0];
      if (!target) {
        setScanResult({
          ok: false,
          message: `User @${parsed.username} could not be found or is blocked.`,
        });
        return;
      }
      const targetDevice = target.devices.find((d) => d.deviceId === parsed.deviceId);
      if (!targetDevice) {
        setScanResult({
          ok: false,
          message: `Scanned device ID is no longer active for @${target.username}.`,
        });
        return;
      }
      if (targetDevice.fingerprint !== parsed.fingerprint) {
        setScanResult({
          ok: false,
          message: `SECURITY WARNING: Public key fingerprint mismatch for @${target.username}! Expected ${targetDevice.fingerprint}, scanned ${parsed.fingerprint}.`,
        });
        return;
      }

      const updatedVault: DeviceKeyVault = {
        ...vault,
        verifiedPeerDevices: {
          ...vault.verifiedPeerDevices,
          [targetDevice.deviceId]: targetDevice.fingerprint,
        },
      };
      saveVaultToLocal(user.username, deviceId, updatedVault);
      onVaultUpdated(updatedVault);
      stopCamera();
      setScanResult({
        ok: true,
        message: `Device verified for @${target.username} (${targetDevice.deviceName}).`,
        matchedUser: target,
        fingerprint: targetDevice.fingerprint,
      });
    } catch (err) {
      setScanResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to verify identity against server directory.',
      });
    }
  }

  async function startCameraScanner() {
    setCameraError(null);
    setScanResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      setCameraActive(true);

      requestAnimationFrame(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});

        const scanFrame = () => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas || !streamRef.current) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const decoded = jsQR(imgData.data, imgData.width, imgData.height);
              if (decoded?.data) {
                verifyScannedQrString(decoded.data);
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanFrame);
        };
        rafRef.current = requestAnimationFrame(scanFrame);
      });
    } catch {
      setCameraError('Camera access denied or no webcam available. Upload a QR image or paste a QR payload below.');
      setCameraActive(false);
    }
  }

  async function handleQrImageUpload(file: File) {
    setCameraError(null);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = jsQR(imgData.data, imgData.width, imgData.height);
        URL.revokeObjectURL(url);
        if (decoded?.data) {
          verifyScannedQrString(decoded.data);
        } else {
          setScanResult({ ok: false, message: 'No QR code detected in the uploaded image.' });
        }
      } else {
        URL.revokeObjectURL(url);
      }
    };
    img.src = url;
  }

  async function handleBlock(userId: string, username: string) {
    await rrApi.blockUser(token, userId);
    setStatusMsg(`Blocked @${username}. They can no longer message or discover you.`);
    await loadDirectory();
  }

  async function handleUnblock(userId: string, username: string) {
    await rrApi.unblockUser(token, userId);
    setStatusMsg(`Unblocked @${username}.`);
    await loadDirectory();
  }

  async function handleReportSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reportTarget || !reportReason.trim()) return;
    await rrApi.reportUser(token, reportTarget.id, reportReason.trim());
    setStatusMsg(`Abuse report submitted for @${reportTarget.username}.`);
    setReportTarget(null);
    setReportReason('');
  }

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8 space-y-8">
      <div className="max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              Username Directory &amp; Contacts
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Discover contacts by username or verify device encryption keys immediately by scanning an identity QR
              code.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowMyQrModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-purple-500/60 text-zinc-800 dark:text-zinc-200 whitespace-nowrap shrink-0"
            >
              <QrCode className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              My Identity QR
            </button>
            <button
              type="button"
              onClick={() => setShowScannerModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap shrink-0"
            >
              <ScanLine className="w-4 h-4" />
              Scan QR Code
            </button>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            loadDirectory(query);
          }}
          className="flex items-center gap-3"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                loadDirectory(e.target.value);
              }}
              placeholder="Search by @username or display name..."
              className="w-full pl-10 pr-4 py-2.5 rr-glass border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-purple-500"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2.5 text-sm font-medium rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/50 text-zinc-800 dark:text-zinc-200 whitespace-nowrap shrink-0"
          >
            Search
          </button>
        </form>

        {statusMsg && (
          <div className="p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800/60 text-sm text-purple-900 dark:text-purple-200 flex items-center justify-between gap-4">
            <span>{statusMsg}</span>
            <button
              type="button"
              onClick={() => setStatusMsg(null)}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl divide-y divide-zinc-200 dark:divide-zinc-800/80">
          {loading ? (
            <div className="p-8 text-sm text-zinc-500 dark:text-zinc-400">Searching encrypted username directory...</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                No matching discoverable users found
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Scan another user&apos;s identity QR code or register a second account in another browser tab to test
                device verification.
              </p>
            </div>
          ) : (
            users.map((u) => {
              const primaryDev = u.devices[0];
              const isQrVerified =
                primaryDev && vault.verifiedPeerDevices[primaryDev.deviceId] === primaryDev.fingerprint;
              const badgeKey = u.identity3D?.badge;
              const badgeLabel = badgeKey && badgeKey !== 'none' ? BADGE_LABELS[badgeKey] : null;

              return (
                <div key={u.id} className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2 text-sm flex-wrap">
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{u.displayName}</span>
                      <span aria-hidden="true" className="text-zinc-400">
                        ·
                      </span>
                      <span className="font-mono text-purple-600 dark:text-purple-400">@{u.username}</span>
                      <span aria-hidden="true" className="text-zinc-400">
                        ·
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {u.devices.length} active device(s)
                      </span>
                      {badgeLabel && (
                        <>
                          <span aria-hidden="true" className="text-zinc-400">
                            ·
                          </span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-300">{badgeLabel}</span>
                        </>
                      )}
                      {isQrVerified && (
                        <>
                          <span aria-hidden="true" className="text-zinc-400">
                            ·
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 font-medium">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            Verified
                          </span>
                        </>
                      )}
                    </div>
                    {u.bio && <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{u.bio}</p>}
                    {primaryDev && (
                      <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-500">
                        <Fingerprint className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        <span className="truncate">Primary Key: {primaryDev.fingerprint}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onStartDirectChat(u)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white transition-colors whitespace-nowrap shrink-0"
                    >
                      <MessageSquarePlus className="w-3.5 h-3.5" />
                      Encrypted Chat
                    </button>
                    <button
                      type="button"
                      onClick={() => handleBlock(u.id, u.username)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-red-500/60 text-zinc-700 dark:text-zinc-300 hover:text-red-500 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Ban className="w-3.5 h-3.5" />
                      Block
                    </button>
                    <button
                      type="button"
                      onClick={() => setReportTarget(u)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-amber-500/60 text-zinc-700 dark:text-zinc-300 hover:text-amber-500 transition-colors whitespace-nowrap shrink-0"
                    >
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Report
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {blockedUsers.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Blocked Users</h2>
            <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl divide-y divide-zinc-200 dark:divide-zinc-800/80">
              {blockedUsers.map((b) => (
                <div key={b.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="text-sm">
                    <span className="font-medium text-zinc-900 dark:text-zinc-200">{b.displayName}</span>
                    <span className="text-zinc-400 mx-2">·</span>
                    <span className="font-mono text-zinc-500 dark:text-zinc-400">@{b.username}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUnblock(b.id, b.username)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 hover:border-purple-500/50 whitespace-nowrap shrink-0"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-purple-500" />
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* My Identity QR Code Modal */}
        {showMyQrModal && (
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div className="w-full max-w-md bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">My Identity QR Code</h3>
                <button
                  type="button"
                  onClick={() => setShowMyQrModal(false)}
                  className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Let another RRchat 1 user scan this QR code in person or via screenshot to verify @{user.username}&apos;s
                device public key fingerprint. Private contact numbers are never included.
              </p>
              <div className="flex justify-center py-2">
                {myQrDataUrl ? (
                  <img
                    src={myQrDataUrl}
                    alt={`RRchat 1 identity QR for @${user.username}`}
                    className="w-60 h-60 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white p-2"
                  />
                ) : (
                  <div className="w-60 h-60 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center text-xs text-zinc-500">
                    Generating QR...
                  </div>
                )}
              </div>
              <div className="p-3 bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl font-mono text-[11px] text-purple-700 dark:text-purple-300 break-all">
                {vault.fingerprint}
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(myQrPayload));
                    setCopiedPayload(true);
                    setTimeout(() => setCopiedPayload(false), 2000);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200"
                >
                  {copiedPayload ? <Check className="w-3.5 h-3.5 text-purple-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedPayload ? 'Copied Payload' : 'Copy QR Payload'}
                </button>
                {myQrDataUrl && (
                  <a
                    href={myQrDataUrl}
                    download={`rrchat1-${user.username}-identity-qr.png`}
                    className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                  >
                    Download PNG
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {/* QR Code Scanner Modal */}
        {showScannerModal && (
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div className="w-full max-w-lg bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Scan Identity QR Code</h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Verify another user&apos;s ECDH/ECDSA device key fingerprint using camera, QR image upload, or
                    payload text.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowScannerModal(false)}
                  className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={cameraActive ? stopCamera : startCameraScanner}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                >
                  <Camera className="w-4 h-4" />
                  {cameraActive ? 'Stop Camera' : 'Start Camera Scan'}
                </button>

                <input
                  ref={qrUploadInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleQrImageUpload(file);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => qrUploadInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 hover:border-purple-500/60"
                >
                  <Upload className="w-4 h-4" />
                  Upload QR Image
                </button>
              </div>

              {cameraError && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-200">
                  {cameraError}
                </div>
              )}

              {cameraActive && (
                <div className="relative rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-black aspect-video flex items-center justify-center">
                  <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
                  <canvas ref={canvasRef} className="hidden" />
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (manualPayload.trim()) verifyScannedQrString(manualPayload);
                }}
                className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800"
              >
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Or Paste Identity QR Payload
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualPayload}
                    onChange={(e) => setManualPayload(e.target.value)}
                    placeholder='{"v":"rrchat1-id-v1",...}'
                    className="flex-1 px-3 py-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs font-mono text-zinc-900 dark:text-zinc-100"
                  />
                  <button
                    type="submit"
                    className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/60 text-zinc-900 dark:text-zinc-100 whitespace-nowrap"
                  >
                    Verify
                  </button>
                </div>
              </form>

              {scanResult && (
                <div
                  className={`p-4 rounded-xl border text-xs space-y-2 ${
                    scanResult.ok
                      ? 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-700/70 text-purple-900 dark:text-purple-200'
                      : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-700/70 text-red-800 dark:text-red-200'
                  }`}
                >
                  <div className="font-semibold flex items-center gap-2">
                    {scanResult.ok ? (
                      <ShieldCheck className="w-4 h-4 text-purple-500 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-red-500 shrink-0" />
                    )}
                    <span>{scanResult.message}</span>
                  </div>
                  {scanResult.fingerprint && (
                    <div className="font-mono text-[11px] opacity-90 break-all">
                      Verified Key: {scanResult.fingerprint}
                    </div>
                  )}
                  {scanResult.ok && scanResult.matchedUser && (
                    <button
                      type="button"
                      onClick={async () => {
                        const target = scanResult.matchedUser!;
                        setShowScannerModal(false);
                        await onStartDirectChat(target);
                      }}
                      className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                    >
                      <MessageSquarePlus className="w-3.5 h-3.5" />
                      Open Verified Encrypted Chat
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {reportTarget && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <form
              onSubmit={handleReportSubmit}
              className="w-full max-w-md bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl"
            >
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Report @{reportTarget.username}
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Reports submit only the target username and your written reason. Encrypted chat content is never
                uploaded.
              </p>
              <textarea
                required
                rows={3}
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Describe spam, impersonation, or abuse..."
                className="w-full p-3 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-purple-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReportTarget(null)}
                  className="px-4 py-2 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-semibold rounded-xl bg-amber-600 hover:bg-amber-500 text-white"
                >
                  Submit Report
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
