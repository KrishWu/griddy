// MathML Core elements for JSX. @types/react 19 ships no MathML intrinsics, and the About page
// renders its equations as native <math> (Chrome 109+, Firefox, Safari) instead of adding a
// math package. React already creates <math> and its children in the MathML namespace, so this
// file only teaches TypeScript the tags and the few attributes the page uses.  OWNER: about page.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type Bool = "true" | "false";

interface MathMLAttributes extends DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> {
  display?: "block" | "inline";
  displaystyle?: Bool;
  scriptlevel?: string;
  mathvariant?: "normal";
  stretchy?: Bool;
  largeop?: Bool;
  movablelimits?: Bool;
  form?: "prefix" | "infix" | "postfix";
  lspace?: string;
  rspace?: string;
  linethickness?: string;
  width?: string;
  accent?: Bool;
  accentunder?: Bool;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      math: MathMLAttributes;
      mi: MathMLAttributes;
      mn: MathMLAttributes;
      mo: MathMLAttributes;
      mtext: MathMLAttributes;
      mspace: MathMLAttributes;
      mrow: MathMLAttributes;
      mfrac: MathMLAttributes;
      msqrt: MathMLAttributes;
      msub: MathMLAttributes;
      msup: MathMLAttributes;
      msubsup: MathMLAttributes;
      munder: MathMLAttributes;
      mover: MathMLAttributes;
      munderover: MathMLAttributes;
      mtable: MathMLAttributes;
      mtr: MathMLAttributes;
      mtd: MathMLAttributes;
      mstyle: MathMLAttributes;
    }
  }
}
