import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import App from './App';
import { AuthProvider } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './components/ThemeProvider';
import './index.css';

const FRONTEND_BUILD_VERSION = 'ribeirao-login-flow-fix-c0f8490';
console.log('[BUILD]', FRONTEND_BUILD_VERSION);
console.log('[FRONTEND_BUILD]', FRONTEND_BUILD_VERSION);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </AuthProvider>
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'rgb(var(--toast-bg))',
              color: 'rgb(var(--toast-text))',
              border: '1px solid rgb(var(--toast-border))',
            },
            success: {
              iconTheme: {
                primary: '#22C55E',
                secondary: '#071018',
              },
            },
          }}
        />
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
