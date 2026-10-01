import type {ReactNode} from "react";
import {Select} from "@base-ui/react/select";
import {Check, ChevronDown, ChevronUp} from "lucide-react";
import "./brand-controls.css";

export type SelectOption<T> = {value: T; label: string; description?: string; icon?: ReactNode; disabled?: boolean};

export function BrandSelect<T extends string | number>({value, onValueChange, options, label, id, disabled, className = "", tone = "dark"}: {
    value: T; onValueChange?: (value: T) => void; options: readonly SelectOption<T>[];
    label?: string; id?: string; disabled?: boolean; className?: string; tone?: "dark" | "paper";
}) {
    const selected = options.find(option => option.value === value);
    return <span className={`mapae-select ${className}`}><Select.Root<T> value={value} items={options} disabled={disabled} onValueChange={next => {if (next !== null) onValueChange?.(next);}}>
        <Select.Trigger id={id} aria-label={label} className="mapae-select-trigger" data-tone={tone}>
            {selected?.icon && <span className="mapae-select-leading" aria-hidden="true">{selected.icon}</span>}
            <Select.Value className="mapae-select-value" />
            <Select.Icon className="mapae-select-chevron"><ChevronDown size={16} /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
            <Select.Positioner className="mapae-select-positioner" sideOffset={7} align="start" alignItemWithTrigger={false} collisionPadding={12}>
                <Select.Popup className="mapae-select-popup" data-tone={tone}>
                    <Select.ScrollUpArrow className="mapae-select-scroll"><ChevronUp size={15} /></Select.ScrollUpArrow>
                    <Select.List className="mapae-select-list">
                        {options.map(option => <Select.Item key={option.value} value={option.value} label={option.label} disabled={option.disabled} className="mapae-select-item">
                            {option.icon && <span className="mapae-select-leading" aria-hidden="true">{option.icon}</span>}
                            <span className="mapae-select-copy"><Select.ItemText>{option.label}</Select.ItemText>{option.description && <span className="mapae-select-description">{option.description}</span>}</span>
                            <Select.ItemIndicator className="mapae-select-check"><Check size={16} strokeWidth={2.5} /></Select.ItemIndicator>
                        </Select.Item>)}
                    </Select.List>
                    <Select.ScrollDownArrow className="mapae-select-scroll"><ChevronDown size={15} /></Select.ScrollDownArrow>
                </Select.Popup>
            </Select.Positioner>
        </Select.Portal>
    </Select.Root></span>;
}
