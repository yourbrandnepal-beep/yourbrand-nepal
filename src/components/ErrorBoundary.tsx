import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
  firestoreDetails: {
    operationType?: string;
    path?: string | null;
    error?: string;
    userId?: string;
  } | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      message: '',
      firestoreDetails: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let firestoreDetails: ErrorBoundaryState['firestoreDetails'] = null;
    try {
      const parsed = JSON.parse(error.message) as {
        operationType?: string;
        path?: string | null;
        error?: string;
        authInfo?: { userId?: string };
      };
      if (parsed && typeof parsed === 'object' && 'operationType' in parsed) {
        firestoreDetails = {
          operationType: parsed.operationType,
          path: parsed.path,
          error: parsed.error,
          userId: parsed.authInfo?.userId,
        };
      }
    } catch {
      // Not a serialized FirestoreErrorInfo JSON payload
    }

    return {
      hasError: true,
      message: error.message || 'An unexpected application error occurred.',
      firestoreDetails,
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('RRchat 1 ErrorBoundary caught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#06070B] text-zinc-100 flex items-center justify-center p-6">
          <div className="w-full max-w-lg rounded-2xl bg-[#0D1018] border border-red-500/40 p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/40 flex items-center justify-center text-red-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">
                  {this.state.firestoreDetails ? 'Firestore Security or Sync Error' : 'Application Recovery'}
                </h2>
                <p className="text-xs text-zinc-400 mt-1">
                  {this.state.firestoreDetails
                    ? 'A Firestore real-time request was rejected or failed validation.'
                    : 'Something interrupted the active workspace view.'}
                </p>
              </div>
            </div>

            {this.state.firestoreDetails ? (
              <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 text-xs font-mono space-y-1.5 text-zinc-300 overflow-x-auto">
                <div>
                  <span className="text-zinc-500">operation:</span>{' '}
                  <span className="text-purple-400">{this.state.firestoreDetails.operationType}</span>
                </div>
                {this.state.firestoreDetails.path && (
                  <div>
                    <span className="text-zinc-500">path:</span> {this.state.firestoreDetails.path}
                  </div>
                )}
                <div>
                  <span className="text-zinc-500">reason:</span>{' '}
                  <span className="text-red-400">{this.state.firestoreDetails.error}</span>
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 text-xs font-mono text-red-300 break-words">
                {this.state.message}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  this.setState({
                    hasError: false,
                    message: '',
                    firestoreDetails: null,
                  })
                }
                className="px-3.5 py-2 rounded-xl border border-zinc-700 text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Recover View
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white"
              >
                Reload RRchat 1
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
