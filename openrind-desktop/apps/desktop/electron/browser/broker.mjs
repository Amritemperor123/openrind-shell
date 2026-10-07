import electron from 'electron';
const WebContentsView = electron?.WebContentsView || electron?.default?.WebContentsView;
import { randomBytes, createHash } from 'node:crypto';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';

export function createOwnedContentsBroker({ getMainWindow, clock = Date.now } = {}) {
  const views = new Map(); // viewId -> record
  const sessions = new Map(); // sessionId -> Set of viewIds

  function checkUrlAllowed(targetUrl, allowedOrigins = []) {
    let u;
    try {
      u = new URL(targetUrl);
    } catch {
      throw new BrowserFault('POLICY_DENIED');
    }
    if (u.protocol !== 'https:' && targetUrl !== 'about:blank') {
      throw new BrowserFault('POLICY_DENIED');
    }
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(u.origin)) {
      throw new BrowserFault('POLICY_DENIED');
    }
    return u;
  }

  function getRecord(viewId, owner) {
    const record = views.get(viewId);
    if (!record) {
      throw new BrowserFault('SESSION_LOST');
    }
    if (owner && record.owner !== owner && !(owner === 'desktop_owner' && record.owner === 'desktop_user')) {
      throw new BrowserFault('SESSION_LOST');
    }
    if (record.fenced) {
      throw new BrowserFault('SESSION_LOST');
    }
    if (record.humanControl && owner && owner !== 'desktop_user') {
      throw new BrowserFault('ACTION_NOT_POSSIBLE');
    }
    return record;
  }

  return {
    views,

    createView({ owner, sessionId, conversationId, partition, bounds, allowedOrigins = [] }) {
      if (!owner || !sessionId) throw new BrowserFault('INVALID_ARGUMENT');

      const viewId = `bv_${randomBytes(16).toString('hex')}`;
      const viewPartition = partition || `openrind-browser-${randomBytes(8).toString('hex')}`;

      // Strictly hardened preferences: no node, no preload, isolated, sandboxed
      const view = new WebContentsView({
        webPreferences: {
          partition: viewPartition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          webviewTag: false,
          allowRunningInsecureContent: false,
          plugins: false,
        },
      });

      const wc = view.webContents;
      const record = {
        viewId,
        owner,
        sessionId,
        conversationId,
        view,
        wc,
        fenced: false,
        epoch: 1,
        documentGeneration: 1,
        allowedOrigins: [...allowedOrigins],
        createdAt: clock(),
      };

      // Security guards: lock down permissions and popups
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.session.setPermissionRequestHandler((_w, _permission, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);

      // Navigation and redirect guard
      const guardNavigation = (event, targetUrl) => {
        try {
          checkUrlAllowed(targetUrl, record.allowedOrigins);
        } catch {
          event.preventDefault();
        }
      };

      wc.on('will-navigate', guardNavigation);
      wc.on('will-redirect', guardNavigation);

      // Detach and crash fencing
      wc.debugger.on('detach', (_event, reason) => {
        // Do not fence on target closed or process swaps caused by normal navigation
        if (reason && reason !== 'target closed' && reason !== 'replaced_with_devtools') {
          // Keep record alive, allow re-attachment
        }
      });

      wc.on('render-process-gone', (_event, details) => {
        if (details?.reason === 'crashed' || details?.reason === 'killed' || details?.reason === 'oom') {
          record.fenced = true;
          record.epoch++;
          try { view.setVisible(false); } catch {}
        }
      });

      // Synchronize in-page navigation and history state with Desktop UI
      const notifyNavigation = () => {
        try {
          const currentUrl = wc.getURL();
          const canBack = Boolean(wc.navigationHistory?.canGoBack?.() ?? wc.canGoBack?.());
          const canForward = Boolean(wc.navigationHistory?.canGoForward?.() ?? wc.canGoForward?.());
          const mainWindow = getMainWindow?.();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('openrind-desktop:browser:event', {
              type: 'navigate',
              viewId,
              url: currentUrl,
              canGoBack: canBack,
              canGoForward: canForward,
            });
          }
        } catch {}
      };

      wc.on('did-navigate', notifyNavigation);
      wc.on('did-navigate-in-page', notifyNavigation);

      // Track view
      views.set(viewId, record);
      const sessionViews = sessions.get(sessionId) || new Set();
      sessionViews.add(viewId);
      sessions.set(sessionId, sessionViews);

      // Attach to main window if available
      const mainWindow = getMainWindow?.();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          // Hide and detach any previous child views so only one active view is rendered
          for (const [existingId, existingRecord] of views) {
            if (existingId !== viewId && existingRecord.view && !existingRecord.wc.isDestroyed()) {
              try {
                existingRecord.view.setVisible(false);
                mainWindow.contentView.removeChildView(existingRecord.view);
              } catch {}
            }
          }
          mainWindow.contentView.addChildView(view);
          if (bounds) {
            const zoom = mainWindow?.webContents?.getZoomFactor?.() || 1;
            view.setBounds({
              x: Math.max(0, Math.round((bounds.x || 0) * zoom)),
              y: Math.max(0, Math.round((bounds.y || 0) * zoom)),
              width: Math.max(0, Math.round((bounds.width || 0) * zoom)),
              height: Math.max(0, Math.round((bounds.height || 0) * zoom)),
            });
          }
          mainWindow.webContents.send('openrind-desktop:browser:event', {
            type: 'start',
            viewId,
            conversationId,
            url: 'about:blank',
          });
        } catch {}
      }

      return {
        viewId,
        epoch: record.epoch,
        documentGeneration: record.documentGeneration,
      };
    },

    async initDebugger(viewId, owner) {
      const record = getRecord(viewId, owner);
      const wc = record.wc;

      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3');
          await Promise.race([
            wc.debugger.sendCommand('Page.enable'),
            new Promise((_, r) => setTimeout(() => r(new Error('Debugger command timeout')), 2500))
          ]);
          await Promise.race([
            wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }),
            new Promise((_, r) => setTimeout(() => r(new Error('Debugger command timeout')), 2500))
          ]);
        } catch (err) {
          console.warn('[broker:initDebugger] Notice attaching debugger:', err?.message || err);
        }
      }
    },

    async navigate(viewId, owner, url) {
      const record = getRecord(viewId, owner);
      const targetUrl = typeof url === 'string' ? url : url.href;
      checkUrlAllowed(targetUrl, record.allowedOrigins);

      try {
        record.documentGeneration++;
        await record.wc.loadURL(targetUrl);
        const currentUrl = record.wc.getURL();
        const mainWindow = getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('openrind-desktop:browser:event', {
              type: 'navigate',
              viewId,
              url: currentUrl,
            });
          } catch {}
        }
        return {
          url: currentUrl,
          documentGeneration: record.documentGeneration,
        };
      } catch (err) {
        if (err instanceof BrowserFault) throw err;
        const isAborted = err?.errno === -3 || err?.code === 'ERR_ABORTED' || err?.message?.includes('ERR_ABORTED');
        if (isAborted && !record.wc.isDestroyed()) {
          const currentUrl = record.wc.getURL() || targetUrl;
          console.log('[broker:navigate] Navigation followed redirect/aborted cleanly. URL is:', currentUrl);
          const mainWindow = getMainWindow?.();
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              mainWindow.webContents.send('openrind-desktop:browser:event', {
                type: 'navigate',
                viewId,
                url: currentUrl,
              });
            } catch {}
          }
          return {
            url: currentUrl,
            documentGeneration: record.documentGeneration,
          };
        }
        console.error('[broker:navigate] Navigation failed for:', targetUrl, err?.message || err);
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    async snapshot(viewId, owner, options = {}) {
      const record = getRecord(viewId, owner);
      const depth = options.depth || 8;
      const maxNodes = options.maxNodes || LIMITS.snapshotNodes;
      const maxTextBytes = options.maxTextBytes || LIMITS.snapshotTextBytes;

      try {
        // Execute fixed inspection script through debugger evaluate
        const expr = `(${function (depth, maxNodes, maxTextBytes) {
          let count = 0;
          let textBytes = 0;
          let idCounter = 0;

          const getGeometry = el => {
            if (!el || el.nodeType !== 1) return null;
            const rect = el.getBoundingClientRect();
            const bounds = {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
            const center = [
              Math.round(rect.x + rect.width / 2),
              Math.round(rect.y + rect.height / 2),
            ];
            const hasSize = bounds.width > 0 && bounds.height > 0;
            const vpW = window.innerWidth || document.documentElement.clientWidth || 1024;
            const vpH = window.innerHeight || document.documentElement.clientHeight || 768;
            const inViewport = hasSize &&
              rect.bottom > 0 &&
              rect.top < vpH &&
              rect.right > 0 &&
              rect.left < vpW;

            let hitTestable = false;
            if (inViewport && center[0] >= 0 && center[1] >= 0 && center[0] < vpW && center[1] < vpH) {
              try {
                const hit = document.elementFromPoint(center[0], center[1]);
                hitTestable = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
              } catch {
                hitTestable = false;
              }
            }
            return { bounds, center, inViewport, hitTestable, hasSize };
          };

          const isVisible = (el, geo) => {
            if (!el || el.nodeType !== 1) return true;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return true;
          };

          const getRole = el => {
            const explicit = el.getAttribute('role');
            if (explicit) return explicit.toLowerCase();
            const tag = el.tagName.toLowerCase();
            if (tag === 'button') return 'button';
            if (tag === 'a' && el.hasAttribute('href')) return 'link';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              const type = (el.type || 'text').toLowerCase();
              if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
              if (type === 'checkbox') return 'checkbox';
              if (type === 'radio') return 'radio';
              return 'textbox';
            }
            if (/^h[1-6]$/.test(tag)) return 'heading';
            return null;
          };

          const getName = el => {
            const aria = el.getAttribute('aria-label');
            if (aria && aria.trim()) return aria.trim();
            if (el.id) {
              try {
                const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                if (label && label.textContent.trim()) return label.textContent.trim();
              } catch {}
            }
            const parentLabel = el.closest('label');
            if (parentLabel && parentLabel.textContent.trim()) return parentLabel.textContent.trim();
            if (el.tagName.toLowerCase() === 'input') {
              const type = (el.type || 'text').toLowerCase();
              if (['button', 'submit', 'reset'].includes(type) && el.value) return el.value.trim();
              if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
              if (el.getAttribute('title')) return el.getAttribute('title').trim();
              if (el.name) return el.name;
            }
            if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tagName.toLowerCase())) {
              const text = el.textContent.trim();
              if (text) return text.length > 200 ? text.slice(0, 197) + '...' : text;
            }
            if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
            if (el.getAttribute('title')) return el.getAttribute('title').trim();
            return undefined;
          };

          function traverse(node, currentDepth) {
            if (!node || currentDepth > depth || count >= maxNodes || textBytes >= maxTextBytes) return null;

            if (node.nodeType === 3) {
              const textContent = node.textContent.trim();
              if (!textContent) return null;
              count++;
              textBytes += textContent.length;
              return { kind: 'text', frameId: 'main', text: textContent };
            }

            if (node.nodeType === 1) {
              const geo = getGeometry(node);
              if (!isVisible(node, geo)) return null;
              const tag = node.tagName.toLowerCase();
              if (['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link'].includes(tag)) return null;

              const role = getRole(node);
              const name = getName(node);
              const isPassword = tag === 'input' && (node.type === 'password' || node.getAttribute('type')?.toLowerCase() === 'password');
              const isInteractive = ['button', 'textbox', 'link', 'checkbox', 'radio', 'combobox'].includes(role);
              let handle = undefined;
              if (isInteractive) {
                handle = 'h_' + (++idCounter);
                try { node.setAttribute('data-openrind-handle', handle); } catch {}
              }

              count++;
              const item = {
                kind: 'element',
                frameId: 'main',
                ...(role ? { role } : {}),
                ...(name ? { name } : {}),
                ...(isPassword ? { sensitive: true } : {}),
                ...(role === 'textbox' ? { editable: true } : {}),
                ...(node.checked !== undefined && ['checkbox', 'radio'].includes(role) ? { checked: Boolean(node.checked) } : {}),
                ...(node.disabled !== undefined ? { disabled: Boolean(node.disabled) } : {}),
                ...(geo ? {
                  bounds: geo.bounds,
                  center: geo.center,
                  inViewport: geo.inViewport,
                  hitTestable: geo.hitTestable,
                } : {}),
                ...(handle ? { handle } : {})
              };

              const children = [];
              for (const child of node.childNodes) {
                const c = traverse(child, currentDepth + 1);
                if (c) children.push(c);
              }
              if (children.length > 0) item.children = children;
              return item;
            }
            return null;
          }

          const bodyTree = traverse(document.body, 1);
          return bodyTree ? [bodyTree] : [];
        }})(${depth}, ${maxNodes}, ${maxTextBytes})`;

        let result;
        if (record.wc.debugger.isAttached()) {
          try {
            const evalRes = await record.wc.debugger.sendCommand('Runtime.evaluate', {
              expression: expr,
              returnByValue: true,
            });
            result = evalRes.result?.value;
          } catch {}
        }
        if (!result) {
          result = await record.wc.executeJavaScript(expr);
        }

        return {
          documentGeneration: record.documentGeneration,
          nodes: result || [],
        };
      } catch (err) {
        console.error('[broker:snapshot] Snapshot failed:', err?.message || err);
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    async act(viewId, owner, action) {
      const record = getRecord(viewId, owner);
      const { kind, target, text, values, key, direction, distance } = action;

      try {
        if (target?.handle) {
          const checkExpr = `(${function (handle, kind, text, values, key) {
            const el = document.querySelector('[data-openrind-handle="' + handle + '"]');
            if (!el) return { error: 'STALE_REF' };
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return { error: 'ACTION_NOT_POSSIBLE' };
            }
            if (el.disabled) {
              return { error: 'ACTION_NOT_POSSIBLE' };
            }

            if (kind === 'click') {
              el.scrollIntoView({ block: 'center' });
              el.click();
            } else if (kind === 'fill') {
              el.focus();
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
                                   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) {
                nativeSetter.call(el, text || '');
              } else {
                el.value = text || '';
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (kind === 'select') {
              if (Array.isArray(values) && values.length > 0) {
                el.value = values[0];
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else if (kind === 'press') {
              el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
              if (key === 'Enter') {
                if (el.form) {
                  if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
                  else el.form.submit();
                } else {
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
              }
            }
            return { ok: true };
          }})(${JSON.stringify(target.handle)}, ${JSON.stringify(kind)}, ${JSON.stringify(text || '')}, ${JSON.stringify(values || [])}, ${JSON.stringify(key || '')})`;

          const res = await record.wc.executeJavaScript(checkExpr);
          if (res?.error === 'STALE_REF') throw new BrowserFault('STALE_REF');
          if (res?.error === 'ACTION_NOT_POSSIBLE') throw new BrowserFault('ACTION_NOT_POSSIBLE');
        } else {
          if (kind === 'press') {
            record.wc.sendInputEvent({ type: 'keyDown', keyCode: key });
            record.wc.sendInputEvent({ type: 'keyUp', keyCode: key });
            await record.wc.executeJavaScript(`
              (() => {
                const active = document.activeElement;
                if (active && "${key}" === "Enter") {
                  if (active.form) {
                    if (typeof active.form.requestSubmit === "function") active.form.requestSubmit();
                    else active.form.submit();
                  } else {
                    active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
                    active.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
                  }
                }
              })()
            `).catch(() => {});
          } else if (kind === 'scroll') {
            const dist = distance || 250;
            const deltaX = direction === 'left' ? -dist : direction === 'right' ? dist : 0;
            const deltaY = direction === 'up' ? -dist : direction === 'down' ? dist : 0;
            record.wc.sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaX, deltaY });
          }
        }
      } catch (err) {
        if (err instanceof BrowserFault) throw err;
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    async screenshot(viewId, owner, options = {}) {
      const record = getRecord(viewId, owner);
      try {
        const image = await record.wc.capturePage(options.region);
        return image.toPNG();
      } catch {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    setBounds(viewId, bounds) {
      const record = views.get(viewId);
      if (record && !record.wc.isDestroyed()) {
        record.view.setBounds(bounds);
        if (typeof bounds?.width === 'number' && typeof bounds?.height === 'number') {
          record.view.setVisible(bounds.width > 0 && bounds.height > 0);
        }
      }
    },

    setVisible(viewId, visible) {
      const record = views.get(viewId);
      if (record && !record.wc.isDestroyed()) {
        record.view.setVisible(Boolean(visible));
      }
    },

    goBack(viewId, owner) {
      const record = getRecord(viewId, owner);
      if (record && !record.wc.isDestroyed()) {
        const canBack = Boolean(record.wc.navigationHistory?.canGoBack?.() ?? record.wc.canGoBack?.());
        if (canBack) {
          if (record.wc.navigationHistory?.goBack) record.wc.navigationHistory.goBack();
          else record.wc.goBack();
          return true;
        }
      }
      return false;
    },

    goForward(viewId, owner) {
      const record = getRecord(viewId, owner);
      if (record && !record.wc.isDestroyed()) {
        const canFwd = Boolean(record.wc.navigationHistory?.canGoForward?.() ?? record.wc.canGoForward?.());
        if (canFwd) {
          if (record.wc.navigationHistory?.goForward) record.wc.navigationHistory.goForward();
          else record.wc.goForward();
          return true;
        }
      }
      return false;
    },

    reload(viewId, owner) {
      const record = getRecord(viewId, owner);
      if (record && !record.wc.isDestroyed()) {
        record.wc.reload();
        return true;
      }
      return false;
    },

    destroyView(viewId) {
      const record = views.get(viewId);
      if (record) {
        views.delete(viewId);
        record.fenced = true;
        const mainWindow = getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.contentView.removeChildView(record.view);
          } catch {}
        }
        if (!record.wc.isDestroyed()) {
          try {
            if (record.wc.debugger.isAttached()) {
              record.wc.debugger.detach();
            }
            record.wc.close();
          } catch {}
        }
      }
    },

    destroySession(sessionId) {
      const viewIds = sessions.get(sessionId);
      if (viewIds) {
        sessions.delete(sessionId);
        for (const viewId of viewIds) {
          this.destroyView(viewId);
        }
      }
    },
  };
}
