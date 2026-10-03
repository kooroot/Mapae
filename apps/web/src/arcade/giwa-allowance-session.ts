import type {Address, Hex} from "viem";
import type {createMapaeDelegationProvider} from "@mapae/delegation/x402";
import {validAllowance, type Allowances} from "./allowance";

export type CharacterPermission = {
    characterId: string; name: string; owner: Address; payer: Address; context: Hex; expires: number; limit: number;
    provider: ReturnType<typeof createMapaeDelegationProvider>;
};

/** Spend-capable providers live only in memory. Views contain no keys or permission contexts. */
export class CharacterAllowances {
    private permissions = new Map<string, CharacterPermission & {spent: Set<string>}>();
    get(id: string, now = Date.now() / 1000) {
        const permission = this.permissions.get(id);
        if (permission && permission.expires <= now) {this.permissions.delete(id); return undefined;}
        return permission;
    }
    add(permission: CharacterPermission, now = Date.now() / 1000) {
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(permission.characterId) || !validAllowance(permission.limit) || !Number.isFinite(permission.expires) || permission.expires <= now) throw new Error("Invalid character allowance");
        if (this.remaining(permission.characterId, now) > 0) throw new Error("Stop the existing allowance before signing a new one");
        this.permissions.set(permission.characterId, {...permission, spent: new Set()});
    }
    remaining(id: string, now = Date.now() / 1000) {
        const permission = this.get(id, now);
        return permission ? Math.max(0, permission.limit - permission.spent.size) : 0;
    }
    settled(id: string, requestId: string) {
        // Recovery may finish on another device without a live signing session.
        const permission = this.get(id);
        if (permission) permission.spent.add(requestId);
    }
    view(now = Date.now() / 1000): Allowances {
        return Object.fromEntries([...this.permissions.keys()].flatMap(id => {
            const p = this.get(id, now);
            return p ? [[id, {name: p.name, limit: p.limit, remaining: this.remaining(id, now), expires: p.expires}]] : [];
        }));
    }
    stop(id?: string) {if (id) this.permissions.delete(id); else this.permissions.clear();}
    revoke(context: Hex) {for (const [id, permission] of this.permissions) if (permission.context === context) this.permissions.delete(id);}
}
