import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import App from './App';
import { AuthProvider } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AuthProvider>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#0D1822',
            color: '#F8FAFC',
            border: '1px solid #1F2D3A',
          },
          success: {
            iconTheme: {
              primary: '#22C55E',
              secondary: '#071018',
            },
          },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
