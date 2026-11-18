import React, { useState } from 'react';
import { Calculator, Delete, FileText, Lock, Plus, Trash2 } from 'lucide-react';
import { rrApi } from '../lib/api';

interface DecoyAppScreenProps {
  username: string;
  token: string;
  hasVaultPin: boolean;
  authProvider?: 'local' | 'google' | 'facebook' | 'github' | 'discord';
  duressTriggered?: boolean;
  onUnlockRealApp: () => void;
}

export const DecoyAppScreen: React.FC<DecoyAppScreenProps> = ({
  username,
  token,
  hasVaultPin,
  authProvider,
  onUnlockRealApp,
}) => {
  const [mode, setMode] = useState<'calc' | 'notes'>('calc');
  const [display, setDisplay] = useState('0');
  const [notes, setNotes] = useState<Array<{ id: string; text: string; date: string }>>([
    { id: '1', text: 'Grocery list: Milk, bread, roasted coffee, batteries', date: 'Today' },
    { id: '2', text: 'Dentist appointment confirmed for Thursday 10:30 AM', date: 'Yesterday' },
  ]);
  const [noteInput, setNoteInput] = useState('');
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [unlockPin, setUnlockPin] = useState('');
  const [unlockErr, setUnlockErr] = useState<string | null>(null);

  function pressKey(k: string) {
    if (k === 'C') {
      setDisplay('0');
      return;
    }
    if (k === '=') {
      try {
        // Safe arithmetic-only evaluator (digits + +-*/.)
        if (!/^[0-9+\-*/.()\s]+$/.test(display)) {
          setDisplay('Error');
          return;
        }
        const fn = new Function(`"use strict"; return (${display});`);
        const val = fn();
        setDisplay(Number.isFinite(val) ? String(Number(val.toFixed(6))) : 'Error');
      } catch {
        setDisplay('Error');
      }
      return;
    }
    setDisplay((prev) => (prev === '0' || prev === 'Error' ? k : prev + k));
  }

  async function handleAttemptUnlock(e: React.FormEvent) {
    e.preventDefault();
    setUnlockErr(null);
    try {
      const res = await rrApi.unlockSession(token, unlockPin);
      if (res.duressTriggered) {
        setShowUnlockModal(false);
        setUnlockPin('');
        return;
      }
      setShowUnlockModal(false);
      setUnlockPin('');
      onUnlockRealApp();
    } catch (err) {
      setUnlockErr(err instanceof Error ? err.message : 'Invalid credentials.');
    }
  }

  return (
    <div className="min-h-screen w-screen bg-zinc-100 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col">
      {/* Discreet Utility Topbar */}
      <header className="h-14 px-5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {mode === 'calc' ? (
            <Calculator className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
          ) : (
            <FileText className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
          )}
          <span>{mode === 'calc' ? 'Pocket Calc & Notes' : 'Personal Field Notes'}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMode('calc')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              mode === 'calc' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500'
            }`}
          >
            Calculator
          </button>
          <button
            type="button"
            onClick={() => setMode('notes')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              mode === 'notes' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500'
            }`}
          >
            Notes
          </button>
          <button
            type="button"
            onClick={() => setShowUnlockModal(true)}
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            title="Unlock Workspace"
          >
            <Lock className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        {mode === 'calc' ? (
          <div className="w-full max-w-xs rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-5 shadow-lg space-y-4">
            <div className="p-4 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-right font-mono text-2xl tabular-nums overflow-x-auto">
              {display}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', 'C', '0', '.', '+'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pressKey(k)}
                  className="py-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 font-mono text-sm font-semibold"
                >
                  {k}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDisplay((d) => (d.length > 1 ? d.slice(0, -1) : '0'))}
                className="col-span-2 py-3 rounded-xl bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center"
              >
                <Delete className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => pressKey('=')}
                className="col-span-2 py-3 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-mono text-sm font-bold"
              >
                =
              </button>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-5 shadow-lg space-y-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!noteInput.trim()) return;
                setNotes((prev) => [{ id: String(Date.now()), text: noteInput.trim(), date: 'Just now' }, ...prev]);
                setNoteInput('');
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder="Add quick reminder..."
                className="flex-1 px-3.5 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
              />
              <button
                type="submit"
                className="px-3.5 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-semibold inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </form>
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {notes.map((n) => (
                <div key={n.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                  <div>
                    <div>{n.text}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">{n.date}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setNotes((prev) => prev.filter((item) => item.id !== n.id))}
                    className="p-1.5 text-zinc-400 hover:text-red-500"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {showUnlockModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleAttemptUnlock}
            className="w-full max-w-xs rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-5 space-y-3 shadow-2xl"
          >
            <div className="text-sm font-semibold">Re-authenticate Session</div>
            <p className="text-xs text-zinc-500">
              {authProvider && authProvider !== 'local'
                ? hasVaultPin
                  ? `Enter your Vault PIN, or type @${username} / UNLOCK.`
                  : `Type your username (${username}) or UNLOCK to return.`
                : 'Enter your primary password or Vault PIN.'}
            </p>
            {unlockErr && <p className="text-xs text-red-500">{unlockErr}</p>}
            <input
              type={authProvider && authProvider !== 'local' && !hasVaultPin ? 'text' : 'password'}
              autoFocus
              required
              value={unlockPin}
              onChange={(e) => setUnlockPin(e.target.value)}
              placeholder={
                authProvider && authProvider !== 'local'
                  ? hasVaultPin
                    ? 'Vault PIN or UNLOCK'
                    : `Type ${username} or UNLOCK`
                  : 'Password or Vault PIN'
              }
              className="w-full px-3 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowUnlockModal(false)}
                className="px-3 py-1.5 text-xs rounded-lg border border-zinc-300 dark:border-zinc-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
              >
                Verify
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
