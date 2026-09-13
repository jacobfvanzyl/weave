// Keep service-owned tabs silent at the Host; tabCapture still receives their audio.
chrome.tabs.onCreated.addListener(tab => { chrome.tabs.update(tab.id, {muted: true}).catch(() => {}); });
chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab => chrome.tabs.update(tab.id, {muted: true}).catch(() => {}))));
// The action is invoked by the service through CDP Extensions.triggerAction.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.update(tab.id, {muted: true});
    const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['USER_MEDIA', 'WEB_RTC'],
        justification: 'Stream service-owned browser tabs to authorized native viewers',
      });
    }
    const {captureRequest} = await chrome.storage.session.get('captureRequest');
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tab.id});
    await chrome.runtime.sendMessage({type: 'capture', streamId, ...captureRequest});
  } catch (error) {
    await chrome.storage.session.set({captureError: String(error)});
  }
});
