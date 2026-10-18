// How a message row tells its action bar to open the message menu: a right-click gives the pointer's place, a long press gives none (the menu is then a sheet). The bar registers its opener here.
import { createContext } from "react";

export type MenuAt = { x: number; y: number } | null;
export type MenuHost = { open: { current: ((at: MenuAt) => void) | null }; /** The row's own switch: while the menu is open its action row stays shown. */ shown?: (on: boolean) => void };
export const MenuHostCtx = createContext<MenuHost | null>(null);
