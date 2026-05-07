import { Component, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    // Keep the error visible in development and production instead of a blank screen.
    console.error('Reliance CRM render error:', error);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-bg px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-3xl rounded-3xl border border-danger/30 bg-panel p-6 shadow-glow">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Erro de interface</p>
            <h1 className="mt-2 text-2xl font-bold text-white">A tela nÃ£o carregou corretamente</h1>
            <p className="mt-3 text-sm text-slate-300">
              Ocorreu um erro ao renderizar a pÃ¡gina. Copie a mensagem abaixo e me envie para eu corrigir exatamente a causa.
            </p>
            <pre className="mt-5 overflow-auto rounded-2xl border border-border bg-bg/80 p-4 text-sm text-red-300">
              {this.state.error.message}
            </pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

