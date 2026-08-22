import { Hono } from 'hono'
import type { AppBindings } from '../types/hono'
export const createApp = () => new Hono<AppBindings>()
