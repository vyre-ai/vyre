// The web build draws the message menu with react-dom's createPortal (PortalHere.web.tsx); @types/react-dom is not installed, so the one function used is declared here.
declare module "react-dom" {
  export function createPortal(children: import("react").ReactNode, container: Element): import("react").ReactPortal;
}
