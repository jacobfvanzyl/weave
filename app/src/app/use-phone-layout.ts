import { useEffect, useState } from 'react';

// Native idiom is stable across keyboard resizing and narrow iPad windows.
export function usePhoneLayout() {
  const [phone, setPhone] = useState(() => document.documentElement.dataset.deviceIdiom === 'phone');
  useEffect(() => {
    const update = () => setPhone(document.documentElement.dataset.deviceIdiom === 'phone');
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-device-idiom'] });
    update(); return () => observer.disconnect();
  }, []);
  return phone;
}
