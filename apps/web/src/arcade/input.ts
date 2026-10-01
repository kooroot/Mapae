const LETTERS = ["KeyQ", "KeyW", "KeyE", "KeyA", "KeyS", "KeyD", "KeyZ", "KeyX", "KeyC"];
const NUMPAD = ["Numpad7", "Numpad8", "Numpad9", "Numpad4", "Numpad5", "Numpad6", "Numpad1", "Numpad2", "Numpad3"];

export function cellForKey(code: string): number | null {
    if (/^Digit[1-9]$/.test(code)) return Number(code.slice(-1)) - 1;
    const letter = LETTERS.indexOf(code);
    if (letter !== -1) return letter;
    const numpad = NUMPAD.indexOf(code);
    return numpad === -1 ? null : numpad;
}

export function isControlTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
            target.closest('[role="dialog"], [role="listbox"], [role="combobox"], [role="switch"]') !== null);
}
