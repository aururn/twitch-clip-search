chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// A panel may disappear mid-scan. Only its own temporary tabs are cleaned up.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'clip-search-scans' || port.sender?.id !== chrome.runtime.id) return;
  const tabs = new Set();
  port.onMessage.addListener(message => {
    if (!Number.isInteger(message.tabId)) return;
    if (message.type === 'track') tabs.add(message.tabId);
    if (message.type === 'release') tabs.delete(message.tabId);
  });
  port.onDisconnect.addListener(() => {
    for (const tabId of tabs) chrome.tabs.remove(tabId).catch(() => {});
  });
});
