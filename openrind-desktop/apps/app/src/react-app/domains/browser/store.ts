import { useState, useCallback, useEffect, useRef } from 'react';
import type { BrowserPanelState, BrowserProviderKind, BrowserSessionStatus, BrowserTab } from './types';

const defaultState: BrowserPanelState = {
  isOpen: false,
  viewId: undefined,
  provider: 'local-chromium',
  status: 'idle',
  currentUrl: 'about:blank',
  trustedOrigin: null,
  tabs: [],
  activeTabId: null,
  handoff: { active: false },
  artifacts: [],
  error: null,
};

export function useBrowserStore(conversationId: string, sandboxName?: string) {
  const [state, setState] = useState<BrowserPanelState>(defaultState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const electron = (typeof window !== 'undefined' ? (window as any).__OPENRIND_DESKTOP_ELECTRON__ : undefined);

  const startSession = useCallback(async (provider: BrowserProviderKind, initialUrl?: string) => {
    setState(s => ({ ...s, status: 'starting', provider, error: null }));
    try {
      if (electron?.browser?.start) {
        const res = await electron.browser.start({
          sessionId: `bs_${Date.now()}`,
          conversationId,
          initialUrl: initialUrl || 'about:blank',
        });
        const initialTab: BrowserTab = {
          pageId: 'bp_main',
          url: initialUrl || 'about:blank',
          documentGeneration: 1,
        };
        setState(s => ({
          ...s,
          isOpen: true,
          viewId: res.viewId,
          status: 'ready',
          currentUrl: initialUrl || 'about:blank',
          trustedOrigin: initialUrl ? new URL(initialUrl).origin : null,
          tabs: [initialTab],
          activeTabId: initialTab.pageId,
          handoff: { active: false },
        }));
      } else {
        // Fallback for non-electron or mock environments
        setState(s => ({ ...s, isOpen: true, status: 'ready', currentUrl: initialUrl || 'about:blank' }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, status: 'error', error: err?.message || 'Failed to start browser' }));
    }
  }, [conversationId, electron]);

  const stopSession = useCallback(async () => {
    setState(s => ({ ...s, status: 'closing' }));
    try {
      if (electron?.browser?.stop && stateRef.current.viewId) {
        await electron.browser.stop({ viewId: stateRef.current.viewId });
      }
    } catch {}
    setState(s => ({ ...defaultState, isOpen: false }));
  }, [electron]);

  const navigate = useCallback(async (url: string) => {
    if (!url) return;
    let target = url.trim();
    if (!target.startsWith('https://') && !target.startsWith('http://') && target !== 'about:blank') {
      target = `https://${target}`;
    }
    try {
      const activeId = stateRef.current.activeTabId || stateRef.current.tabs[0]?.pageId;
      const cleanTitle = target === 'about:blank' ? 'New Tab' : target.replace(/^https?:\/\//, '');
      setState(s => ({
        ...s,
        currentUrl: target,
        trustedOrigin: target.startsWith('https://') ? new URL(target).origin : null,
        tabs: s.tabs.map(t => t.pageId === activeId ? { ...t, url: target, title: cleanTitle } : t),
      }));
      if (electron?.browser?.navigate && stateRef.current.viewId) {
        const res = await electron.browser.navigate({ viewId: stateRef.current.viewId, url: target });
        const finalUrl = res.url || target;
        const finalTitle = finalUrl === 'about:blank' ? 'New Tab' : finalUrl.replace(/^https?:\/\//, '');
        setState(s => ({
          ...s,
          currentUrl: finalUrl,
          tabs: s.tabs.map(t => t.pageId === activeId ? { ...t, url: finalUrl, title: finalTitle } : t),
        }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Navigation failed' }));
    }
  }, [electron]);

  const takeControl = useCallback(async () => {
    try {
      if (electron?.browser?.takeControl && stateRef.current.viewId) {
        const res = await electron.browser.takeControl({ viewId: stateRef.current.viewId });
        setState(s => ({
          ...s,
          status: 'human_control',
          handoff: { active: true, handoffId: res.handoffId, epoch: res.epoch },
        }));
      } else {
        setState(s => ({ ...s, status: 'human_control', handoff: { active: true } }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Take control failed' }));
    }
  }, [electron]);

  const resumeControl = useCallback(async () => {
    try {
      if (electron?.browser?.resume && stateRef.current.viewId) {
        const res = await electron.browser.resume({ viewId: stateRef.current.viewId });
        setState(s => ({
          ...s,
          status: 'ready',
          handoff: { active: false, epoch: res.epoch },
        }));
      } else {
        setState(s => ({ ...s, status: 'ready', handoff: { active: false } }));
      }
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Resume control failed' }));
    }
  }, [electron]);

  const setBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    if (electron?.browser?.setBounds && stateRef.current.viewId) {
      electron.browser.setBounds({ viewId: stateRef.current.viewId, bounds }).catch(() => {});
    }
  }, [electron]);

  const setVisible = useCallback((visible: boolean) => {
    if (electron?.browser?.setVisible && stateRef.current.viewId) {
      electron.browser.setVisible({ viewId: stateRef.current.viewId, visible }).catch(() => {});
    }
    setState(s => ({ ...s, isOpen: visible }));
  }, [electron]);

  useEffect(() => {
    if (!electron?.browser?.onEvent) return;
    const unsub = electron.browser.onEvent((evt: any) => {
      if (!evt) return;
      if (evt.type === 'start' || evt.type === 'navigate') {
        setState(s => ({
          ...s,
          isOpen: true,
          status: 'ready',
          viewId: evt.viewId || s.viewId,
          currentUrl: evt.url || s.currentUrl,
        }));
      } else if (evt.type === 'stop') {
        setState(s => ({
          ...s,
          isOpen: false,
          status: 'idle',
        }));
      }
    });
    return unsub;
  }, [electron]);

  const openTab = useCallback(async (url: string = 'about:blank') => {
    const newPageId = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newTab: BrowserTab = {
      pageId: newPageId,
      url: url,
      title: url === 'about:blank' ? 'New Tab' : 'Page',
      documentGeneration: 1,
    };
    setState(s => ({
      ...s,
      tabs: [...s.tabs, newTab],
      activeTabId: newPageId,
      currentUrl: url,
    }));
    if (url !== 'about:blank' && electron?.browser?.navigate && stateRef.current.viewId) {
      await navigate(url);
    }
  }, [electron, navigate]);

  const closeTab = useCallback((pageId: string) => {
    setState(s => {
      const remaining = s.tabs.filter(t => t.pageId !== pageId);
      if (remaining.length === 0) {
        return {
          ...s,
          tabs: [{ pageId: 'bp_main', url: 'about:blank', documentGeneration: 1 }],
          activeTabId: 'bp_main',
          currentUrl: 'about:blank',
        };
      }
      const nextActive = s.activeTabId === pageId ? remaining[remaining.length - 1].pageId : s.activeTabId;
      const nextTab = remaining.find(t => t.pageId === nextActive) || remaining[0];
      return {
        ...s,
        tabs: remaining,
        activeTabId: nextActive,
        currentUrl: nextTab.url,
      };
    });
  }, []);

  const selectTab = useCallback(async (pageId: string) => {
    const tab = stateRef.current.tabs.find(t => t.pageId === pageId);
    if (!tab) return;
    setState(s => ({
      ...s,
      activeTabId: pageId,
      currentUrl: tab.url,
    }));
    if (electron?.browser?.navigate && stateRef.current.viewId && tab.url) {
      try {
        await electron.browser.navigate({ viewId: stateRef.current.viewId, url: tab.url });
      } catch {}
    }
  }, [electron]);

  return {
    state,
    startSession,
    stopSession,
    navigate,
    takeControl,
    resumeControl,
    setBounds,
    setVisible,
    openTab,
    closeTab,
    selectTab,
  };
}
