import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  IoRemove, IoSend, IoSparkles, IoKeyOutline,
  IoCheckmarkCircle, IoAlertCircle, IoLockClosed,
} from 'react-icons/io5';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useDrag from '../../hooks/useDrag';
import { useAppStore } from '../../store/appStore';
import './ChatPanel.css';

const VENDOR_META = {
  deepseek: { name: 'DeepSeek', icon: '🔵', color: '#4A90D9' },
  gemini:   { name: 'Gemini',   icon: '🟢', color: '#34A853' },
  claude:   { name: 'Claude',   icon: '🟣', color: '#A855F7' },
  codex:    { name: 'Codex',    icon: '🟡', color: '#F59E0B' },
};

export default function ChatPanel({ onShrink, buttonRef }) {
  const { t } = useTranslation();
  const api = useElectronAPI();

  const chatPanelOpen = useAppStore(s => s.chatPanelOpen);
  const chatMessages = useAppStore(s => s.chatMessages);
  const chatSending = useAppStore(s => s.chatSending);
  const chatSetupStep = useAppStore(s => s.chatSetupStep);
  const chatError = useAppStore(s => s.chatError);
  const chatConfig = useAppStore(s => s.chatConfig);
  const chatConfigPath = useAppStore(s => s.chatConfigPath);
  const chatAvailableModels = useAppStore(s => s.chatAvailableModels);

  const setChatSending = useAppStore(s => s.setChatSending);
  const setChatSetupStep = useAppStore(s => s.setChatSetupStep);
  const setChatError = useAppStore(s => s.setChatError);
  const clearChatError = useAppStore(s => s.clearChatError);
  const setChatConfig = useAppStore(s => s.setChatConfig);
  const setChatConfigPath = useAppStore(s => s.setChatConfigPath);
  const setChatAvailableModels = useAppStore(s => s.setChatAvailableModels);
  const showToast = useAppStore(s => s.showToast);

  const [inputValue, setInputValue] = useState('');
  const [vendorKeys, setVendorKeys] = useState({});
  const [opening, setOpening] = useState(true);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const { pos: dragPos, isDragging, hasDragged, headerHandlers } = useDrag({ panelRef, enabled: !closing });

  useEffect(() => {
    requestAnimationFrame(() => setOpening(false));
  }, []);

  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    if (chatSetupStep === 'ready' && inputRef.current) inputRef.current.focus();
  }, [chatSetupStep]);

  // Load config on mount
  useEffect(() => { loadConfig(); }, []);

  // Chat events
  useEffect(() => {
    if (!api || !api.onCloudChatEvent) return;
    const handler = (data) => {
      // Check done FIRST — the done event may carry accumulated thinking,
      // and we must finalize + stop the spinner before handling anything else.
      if (data.done) {
        const msgs = useAppStore.getState().chatMessages;
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        if (last && last._streaming) {
          useAppStore.setState({
            chatMessages: [...msgs.slice(0, -1), { role: 'assistant', content: data.full || '', thinking: data.thinking || last.thinking || '' }],
            chatSending: false,
          });
        } else {
          useAppStore.setState({
            chatMessages: [...msgs, { role: 'assistant', content: data.full || '', thinking: data.thinking || '' }],
            chatSending: false,
          });
        }
        return;
      }
      if (data.thinking) {
        const msgs = useAppStore.getState().chatMessages;
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        if (last && last.role === 'assistant' && last._streaming) {
          // Append to existing streaming placeholder
          useAppStore.setState({
            chatMessages: msgs.map((m, i) => i === msgs.length - 1
              ? { ...m, thinking: (m.thinking || '') + data.thinking }
              : m),
          });
        } else {
          // Create new streaming placeholder
          useAppStore.setState({
            chatMessages: [...msgs, { role: 'assistant', content: '', thinking: data.thinking, _streaming: true }],
          });
        }
        return;
      }
      if (data.toolCall || data.toolResult) return;
    };
    api.onCloudChatEvent(handler);
    return () => { if (api.offCloudChatEvent) api.offCloudChatEvent(handler); };
  }, [api]);

  const loadConfig = async () => {
    if (!api || !api.getConfig) return;
    try {
      const result = await api.getConfig();
      if (result.success) {
        setChatConfig(result.config);
        setChatConfigPath(result.configPath || '');
        setVendorKeys({
          deepseek: result.config.deepseekKey,
          gemini: result.config.geminiKey,
          claude: result.config.claudeKey,
          codex: result.config.codexKey,
        });

        const hasAnyKey = Object.values(result.config).some(v => typeof v === 'string' && v.length > 0);
        if (hasAnyKey) {
          computeAvailableModels(result.config);
          setChatSetupStep('ready');
        } else {
          setChatSetupStep('vendors');
        }
      }
    } catch (_) { setChatSetupStep('vendors'); }
  };

  const computeAvailableModels = (config) => {
    // This mirrors cloud-llm.js VENDORS structure
    const all = [
      { vendor: 'deepseek', name: 'DeepSeek', icon: '🔵', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], key: config.deepseekKey },
      { vendor: 'gemini', name: 'Gemini', icon: '🟢', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], key: config.geminiKey },
      { vendor: 'claude', name: 'Claude', icon: '🟣', models: ['claude-sonnet-4-6', 'claude-haiku-4-5'], key: config.claudeKey },
      { vendor: 'codex', name: 'Codex', icon: '🟡', models: ['gpt-4o', 'gpt-4o-mini'], key: config.codexKey },
    ];
    const available = [];
    for (const v of all) {
      if (v.key) {
        for (const m of v.models) available.push({ model: m, vendor: v.vendor, vendorName: v.name, icon: v.icon });
      }
    }
    setChatAvailableModels(available);
    // Auto-select first available model if none selected
    if (!config.selectedModel && available.length > 0) {
      const first = available[0];
      const updated = { ...config, selectedModel: first.model };
      setChatConfig(updated);
      api.saveConfig({ selectedModel: first.model });
    }
  };

  const handleSaveVendorKey = async (vendor) => {
    const key = (vendorKeys[vendor] || '').trim();
    if (!key) return;
    const updates = { [vendor + 'Key']: key };
    try {
      await api.saveConfig(updates);
      const newConfig = { ...chatConfig, ...updates };
      setChatConfig(newConfig);
      setVendorKeys(prev => ({ ...prev, [vendor]: key }));
      computeAvailableModels(newConfig);
      showToast(VENDOR_META[vendor].name + ' key saved', 'success');
    } catch (e) {
      setChatError('Failed to save: ' + e.message);
    }
  };

  const handleContinue = () => {
    if (chatAvailableModels.length > 0) {
      setChatSetupStep('ready');
    }
  };

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || chatSending) return;
    setInputValue('');
    setChatError(null);
    setChatSending(true);
    useAppStore.setState({ chatMessages: [{ role: 'user', content: text }] });

    try {
      const result = await api.cloudChat({ messages: [{ role: 'user', content: text }] });
      if (!result.success) {
        setChatSending(false);
        setChatError(result.error || 'Unknown error');
        showToast(result.error || 'Chat request failed', 'error');
      }
    } catch (e) {
      setChatSending(false);
      setChatError('Chat failed: ' + (e.message || 'Unknown error'));
      showToast('Chat request failed', 'error');
    }
  }, [inputValue, chatSending, api]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleShrink = useCallback(() => {
    setClosing(true);
    setTimeout(() => { if (onShrink) onShrink(); }, 250);
  }, [onShrink]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') handleShrink(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleShrink]);

  const panelStyle = {};
  if (dragPos.left !== null && dragPos.top !== null) {
    panelStyle.left = dragPos.left + 'px';
    panelStyle.top = dragPos.top + 'px';
    panelStyle.right = 'auto';
  } else {
    panelStyle.right = '16px';
    panelStyle.bottom = '56px';
  }

  // ── Vendor Setup Screen ────────────────────────────────

  function renderVendorSetup() {
    return (
      <div className="chat-setup" style={{ justifyContent: 'flex-start', paddingTop: 16, gap: 12 }}>
        {chatConfigPath && (
          <div className="chat-config-path">{t('chat_config_path', { path: chatConfigPath })}</div>
        )}
        <div className="chat-setup-title" style={{ marginBottom: 0 }}>{t('chat_vendors_title')}</div>
        <div className="chat-setup-desc">{t('chat_vendors_sub')}</div>

        <div className="chat-vendor-list">
          {Object.entries(VENDOR_META).map(([key, meta]) => {
            const hasKey = !!(chatConfig[key + 'Key'] && chatConfig[key + 'Key'].trim());
            return (
              <div key={key} className={`chat-vendor-card${hasKey ? ' unlocked' : ''}`}>
                <div className="chat-vendor-header">
                  <span className="chat-vendor-icon">{meta.icon}</span>
                  <span className="chat-vendor-name">{meta.name}</span>
                  <span className={`chat-vendor-status${hasKey ? ' unlocked' : ''}`}>
                    {hasKey ? <><IoCheckmarkCircle size={12} /> {t('chat_unlocked')}</> : <><IoLockClosed size={12} /> {t('chat_locked')}</>}
                  </span>
                </div>
                {!hasKey && (
                  <div className="chat-vendor-key-row">
                    <input
                      className="chat-input"
                      type="password"
                      value={vendorKeys[key] || ''}
                      onChange={e => setVendorKeys(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={t('chat_enter_key')}
                    />
                    <button
                      className="chat-setup-btn"
                      style={{ padding: '6px 12px', fontSize: 12 }}
                      onClick={() => handleSaveVendorKey(key)}
                      disabled={!(vendorKeys[key] && vendorKeys[key].trim())}
                    >
                      {t('chat_save_key')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button className="chat-setup-btn" onClick={handleContinue} disabled={chatAvailableModels.length === 0}>
          <IoSparkles size={16} />
          {t('chat_continue')}
        </button>
      </div>
    );
  }

  // ── Chat Interface ─────────────────────────────────────

  const currentModel = chatConfig.selectedModel || '';
  const currentVendor = chatAvailableModels.find(m => m.model === currentModel);

  function renderChatInterface() {
    return (
      <>
        <div className="chat-messages">
          {chatMessages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-icon"><IoSparkles /></div>
              <div className="chat-empty-text">{t('chat_welcome')}</div>
            </div>
          )}
          {chatMessages.map((msg, i) => (
            <div key={i} className={`chat-message ${msg.role}`}>
              {msg.thinking && (
                <details className="chat-thinking" open>
                  <summary>{t('chat_thought_process')}</summary>
                  <div className="chat-thinking-content">{msg.thinking}</div>
                </details>
              )}
              {msg.content}
            </div>
          ))}
          {chatSending && (
            <div className="chat-loading">
              <div className="chat-loading-dot" />
              <div className="chat-loading-dot" />
              <div className="chat-loading-dot" />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {chatError && (
          <div className="chat-error">
            <IoAlertCircle size={14} />
            <span>{chatError}</span>
            <button onClick={clearChatError}>{t('dismiss')}</button>
          </div>
        )}

        <div className="chat-input-area">
          {chatAvailableModels.length > 1 && (
            <select
              className="chat-model-select"
              value={currentModel}
              onChange={async (e) => {
                const model = e.target.value;
                const updated = { ...chatConfig, selectedModel: model };
                setChatConfig(updated);
                await api.saveConfig({ selectedModel: model });
              }}
              title={t('chat_select_model')}
            >
              {chatAvailableModels.map(m => (
                <option key={m.model} value={m.model}>{m.icon} {m.model}</option>
              ))}
            </select>
          )}
          {chatAvailableModels.length === 1 && currentVendor && (
            <span className="chat-model-label">{currentVendor.icon} {currentModel}</span>
          )}
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('chat_placeholder')}
            disabled={chatSending}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!inputValue.trim() || chatSending}
            title={t('chat_send')}
          >
            <IoSend size={14} />
          </button>
        </div>
      </>
    );
  }

  // ── Main ───────────────────────────────────────────────

  return createPortal(
    <div
      ref={panelRef}
      className={`chat-panel${opening ? ' opening' : ''}${closing ? ' closing' : ''}${isDragging ? ' dragging' : ''}`}
      style={panelStyle}
    >
      <div className="chat-panel-header" {...headerHandlers}>
        <div className="chat-panel-title">
          <IoSparkles className="chat-panel-title-icon" />
          {t('chat_title')}
        </div>
        <div className="chat-panel-header-actions">
          {chatSetupStep === 'ready' && (
            <button onClick={() => { setChatSetupStep('vendors'); }} title="Manage providers" style={{ fontSize: 11, padding: '2px 6px' }}>
              <IoKeyOutline size={12} />
            </button>
          )}
          <button onClick={handleShrink} title={t('minimize')}>
            <IoRemove size={18} />
          </button>
        </div>
      </div>

      {chatSetupStep === 'ready' ? renderChatInterface() : renderVendorSetup()}
    </div>,
    document.body,
  );
}
