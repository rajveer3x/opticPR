import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { store } from './api';
import { MotionProvider } from './motion';
import { App } from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <MotionProvider>
          <App />
        </MotionProvider>
      </BrowserRouter>
    </Provider>
  </React.StrictMode>,
);
