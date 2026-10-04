import {MAX_OUTING_ADMISSIONS} from "@mapae/arcade/outings";

export const MAX_ALLOWANCE_ADMISSIONS = MAX_OUTING_ADMISSIONS;
export const validAllowance = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ALLOWANCE_ADMISSIONS;
