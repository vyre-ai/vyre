import { createContext, useContext } from "react";

/** The fill role of the card an element sits on, so a 2 pt ring (the avatar's space badge) is drawn in the card's own colour. */
export const CardFill = createContext<"surface-1" | "surface-2" | "surface-3">("surface-2");
export const useCardFill = () => useContext(CardFill);
