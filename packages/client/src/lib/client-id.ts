export const createClientId = (prefix: string) => {
  const createUuid = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, char => {
      const randomValue = globalThis.crypto?.getRandomValues
        ? globalThis.crypto.getRandomValues(new Uint8Array(1))[0]
        : Math.floor(Math.random() * 256);
      return (Number(char) ^ (randomValue & (15 >> (Number(char) / 4)))).toString(16);
    });
  };

  return `${prefix}_${createUuid()}`;
};
