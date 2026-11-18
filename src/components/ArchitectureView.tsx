import React, { useEffect, useState } from 'react';
import { FileCode2, FolderTree, ShieldAlert } from 'lucide-react';
import { rrApi } from '../lib/api';

interface RepoFileEntry {
  path: string;
  size: number;
  group: string;
}

const ROADMAP_STAGES = [
  {
    stage: 'Stage 1',
    title: 'Next-Gen 3D Brand & Cross-Platform UI',
    status: 'Web Live (Dark & Light) · Flutter Scaffolded',
    detail:
      'Black, silver & neon purple glassmorphism with interactive Three.js 3D Identity Studio, mobile 5-tab navigation, and Windows desktop rail.',
  },
  {
    stage: 'Stage 2',
    title: 'Username Auth, Recovery & Security Radar',
    status: 'Implemented (Web + Backend)',
    detail:
      'Argon2id password hashing, RFC 6238 TOTP 2FA, recovery codes, Trusted Device approvals, Emergency Privacy Mode, and Private Vault App PIN.',
  },
  {
    stage: 'Stage 3',
    title: 'Private Server, Firewall & Moderation',
    status: 'Prototype Live · Infra Hardened',
    detail:
      'Docker Compose network isolation, Matrix Synapse, PostgreSQL schema, Caddy TLS 1.3, UFW/nftables, and zero-plaintext Admin Moderation console.',
  },
  {
    stage: 'Stage 4',
    title: 'End-to-End Encrypted 1:1 & Smart Rooms',
    status: 'Live in WebCrypto · Olm/Megolm in Flutter',
    detail:
      'Web client encrypts client-side with ECDH P-256 + HKDF + AES-256-GCM including message edit/delete, Ghost Chat timers, and Smart Room moderation.',
  },
  {
    stage: 'Stage 5',
    title: 'Rich Media, WebRTC Calls & Private Wallet',
    status: 'Implemented (Web)',
    detail:
      'Encrypted photo, video, file & voice note sharing, P2P WebRTC audio/video calls + history log, QR key scanning, and private P2P wallet transfers.',
  },
  {
    stage: 'Stage 6',
    title: 'Opt-In RR AI Assistant',
    status: 'Implemented (Server-Side Gemini)',
    detail:
      'Smart replies, message translation, conversation summaries, writing polish, and voice-to-text strictly gated behind explicit user consent.',
  },
  {
    stage: 'Stage 7',
    title: 'Windows, Android & iOS Native Testing',
    status: 'Pending Native SDK Hardware Run',
    detail:
      'Requires Flutter toolchain verification with Android Keystore, Apple Keychain, and Windows Credential Manager.',
  },
  {
    stage: 'Stage 8',
    title: 'Independent Security Audit & Production Launch',
    status: 'Pending External Penetration Test',
    detail:
      'Automated backend/crypto tests included in tests/security.test.ts. Independent third-party audit required prior to public launch.',
  },
];

export const ArchitectureView: React.FC = () => {
  const [files, setFiles] = useState<RepoFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [fileContent, setFileContent] = useState<string>('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    rrApi
      .getRepoTree()
      .then((res) => {
        setFiles(res.files);
        const preferred = res.files.find((f) => f.path.includes('flutter_app/lib/main.dart')) ?? res.files[0];
        if (preferred) {
          loadFile(preferred.path);
        }
      })
      .catch(() => {});
  }, []);

  async function loadFile(filePath: string) {
    setSelectedPath(filePath);
    setLoadingFile(true);
    try {
      const res = await rrApi.getRepoFile(filePath);
      setFileContent(res.content);
    } catch {
      setFileContent('Unable to read file.');
    } finally {
      setLoadingFile(false);
    }
  }

  const visibleFiles = files.filter((f) => groupFilter === 'all' || f.group === groupFilter);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8 space-y-8">
      <div className="max-w-6xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Architecture, Roadmap &amp; Source Repository
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Inspect the honest completion state across Stages 1–8 and browse the Flutter, Matrix Synapse, PostgreSQL,
            Caddy, firewall, and test suite files in this workspace.
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 flex items-start gap-3 text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
          <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <strong>Security Honesty Notice:</strong> The running web client performs genuine client-side WebCrypto
            E2EE (ECDH P-256 + AES-256-GCM) over HTTPS/WebSockets with zero plaintext stored on the server. Native
            Flutter Matrix Olm/Megolm encryption on Android, iOS, and Windows is authored in{' '}
            <code className="font-mono">flutter_app/</code> and requires native toolchain compilation and external
            penetration testing before production launch.
          </div>
        </div>

        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-zinc-200 dark:border-zinc-800/80">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Development Roadmap Status</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-100 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Stage</th>
                  <th className="py-3 px-4 font-medium">Milestone</th>
                  <th className="py-3 px-4 font-medium">Current Status</th>
                  <th className="py-3 px-4 font-medium">Verification Scope</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/70">
                {ROADMAP_STAGES.map((s) => (
                  <tr key={s.stage} className="hover:bg-zinc-100/60 dark:hover:bg-zinc-900/40">
                    <td className="py-3 px-4 font-mono text-purple-600 dark:text-purple-400 whitespace-nowrap">
                      {s.stage}
                    </td>
                    <td className="py-3 px-4 font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                      {s.title}
                    </td>
                    <td className="py-3 px-4 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">{s.status}</td>
                    <td className="py-3 px-4 text-zinc-500 dark:text-zinc-400">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 min-h-[540px]">
          <div className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-zinc-200 dark:border-zinc-800 flex flex-col">
            <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <FolderTree className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                <span>Project Source Files</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {['all', 'flutter_app', 'infra', 'backend', 'tests', 'docs'].map((grp) => (
                  <button
                    key={grp}
                    type="button"
                    onClick={() => setGroupFilter(grp)}
                    className={`px-2.5 py-1 text-xs rounded-lg transition-colors whitespace-nowrap ${
                      groupFilter === grp
                        ? 'bg-purple-600 text-white'
                        : 'bg-zinc-100 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    {grp}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[480px] divide-y divide-zinc-200 dark:divide-zinc-800/50">
              {visibleFiles.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => loadFile(f.path)}
                  className={`w-full text-left px-4 py-2.5 text-xs flex items-center justify-between gap-2 transition-colors ${
                    selectedPath === f.path
                      ? 'bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300'
                      : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900/60'
                  }`}
                >
                  <span className="font-mono truncate">{f.path}</span>
                  <span className="font-mono tabular-nums text-[11px] text-zinc-500 shrink-0">
                    {(f.size / 1024).toFixed(1)}k
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-8 flex flex-col bg-zinc-50 dark:bg-zinc-950">
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 flex items-center gap-2 text-xs font-mono text-zinc-700 dark:text-zinc-300">
              <FileCode2 className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
              <span className="truncate">{selectedPath || 'Select a file to inspect'}</span>
            </div>
            <pre className="flex-1 p-4 overflow-auto max-h-[500px] text-xs font-mono leading-relaxed text-zinc-700 dark:text-zinc-300">
              {loadingFile ? 'Loading file...' : fileContent}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
