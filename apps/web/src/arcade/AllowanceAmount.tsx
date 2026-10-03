import {NumberField} from "@base-ui/react/number-field";
import {useEffect, useId, useState} from "react";
import {Minus, Plus} from "lucide-react";
import {ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";
import {MAX_ALLOWANCE_ADMISSIONS, validAllowance} from "./allowance";

export function AllowanceAmount({name, value, disabled, ko, onChange, onValidityChange}: {
    name: string; value: number; disabled: boolean; ko: boolean;
    onChange: (admissions: number) => void; onValidityChange: (valid: boolean) => void;
}) {
    const id = useId(), help = `${id}-help`;
    const [draft, setDraft] = useState<number | null>(value * ARCADE_TICKET_COST);
    useEffect(() => {setDraft(value * ARCADE_TICKET_COST); onValidityChange(true);}, [value]);
    const valid = draft !== null && validAllowance(draft / ARCADE_TICKET_COST);
    function change(amount: number | null) {
        setDraft(amount);
        const admissions = amount === null ? null : amount / ARCADE_TICKET_COST;
        const ok = validAllowance(admissions);
        onValidityChange(ok);
        if (ok) onChange(admissions);
    }
    return <div className="arc-allowance-amount">
        <label htmlFor={id}>{ko ? `${name}의 용돈` : `${name}'s allowance`}</label>
        <NumberField.Root id={id} value={draft} onValueChange={change} min={ARCADE_TICKET_COST} max={MAX_ALLOWANCE_ADMISSIONS * ARCADE_TICKET_COST} step={ARCADE_TICKET_COST} smallStep={ARCADE_TICKET_COST} largeStep={5 * ARCADE_TICKET_COST} allowOutOfRange disabled={disabled}>
            <NumberField.Group className="arc-money-stepper">
                <NumberField.Decrement aria-label={ko ? `${name} 용돈 줄이기` : `Decrease ${name}'s allowance`}><Minus size={17} /></NumberField.Decrement>
                <NumberField.Input inputMode="numeric" aria-invalid={!valid} aria-describedby={help} /><span>{MOCK_USDC.symbol}</span>
                <NumberField.Increment aria-label={ko ? `${name} 용돈 늘리기` : `Increase ${name}'s allowance`}><Plus size={17} /></NumberField.Increment>
            </NumberField.Group>
        </NumberField.Root>
        {!disabled && <div className="arc-money-presets" role="group" aria-label={ko ? `${name} 용돈 빠른 선택` : `Quick amounts for ${name}`}>{[1, 3, 5, 10].map(admissions => <button type="button" key={admissions} aria-pressed={draft === admissions * ARCADE_TICKET_COST} onClick={() => change(admissions * ARCADE_TICKET_COST)}>{admissions * ARCADE_TICKET_COST}</button>)}</div>}
        <small id={help} className={!valid ? "arc-money-error" : ""}>{!valid ? ko ? `1–${MAX_ALLOWANCE_ADMISSIONS} 사이의 정수로 입력해 주세요.` : `Enter a whole amount from 1 to ${MAX_ALLOWANCE_ADMISSIONS}.` : ko ? `최대 ${value}번 입장 · 1회 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}` : `Up to ${value} visits · ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} each`}</small>
    </div>;
}
