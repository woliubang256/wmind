import type { AuthSession } from './client';

export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
  expiresIn: number;
}
export type LoginResponse = AuthSession | TwoFactorChallenge;
export interface TwoFactorStatus { enabled: boolean; recoveryCodesRemaining: number }
export interface TwoFactorSetup { secret: string; uri: string; qrCode: string; expiresIn: number }
export interface TwoFactorChange { session?: AuthSession; recoveryCodes?: string[] }
