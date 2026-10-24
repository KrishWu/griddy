// Module resolve hooks so Node can import the app's TypeScript outside Next (gradePercentiles.mjs).
// OWNER: workstream E (Site Intelligence).
// "@/x" resolves to frontend/x.ts, extensionless relative imports from .ts files get ".ts", and
// the React-only modules readSummary's file imports (react, the store, the API client) become
// stubs: scoring never calls them. If A's useSiteSummary.ts starts importing a new name from
// one of them, add it to STUBS.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FRONTEND = new URL("../../../", import.meta.url);
const STUBS = {
  react:
    "export const useEffect=()=>{},useLayoutEffect=()=>{},useMemo=(f)=>f(),useCallback=(f)=>f,useRef=(v)=>({current:v}),useState=(v)=>[typeof v==='function'?v():v,()=>{}],useSyncExternalStore=(_s,g)=>g(),useContext=()=>({}),createContext=()=>({}),useId=()=>'id';export default {};",
  "@/lib/api": "const offline=()=>Promise.reject(new Error('no API offline'));export const api=new Proxy({},{get:()=>offline});export const request=offline,post=offline;",
  "@/lib/store": "export const useGridForge=()=>({});",
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
  let base = null;
  if (specifier.startsWith("@/")) base = new URL(specifier.slice(2), FRONTEND);
  else if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith(".ts") && !/\.(m?[jt]s|json)$/.test(specifier)) base = new URL(specifier, context.parentURL);
  if (base) {
    for (const ext of ["", ".ts", "/index.ts"]) {
      const url = new URL(base.href + ext);
      if (ext === "" && !/\.(m?[jt]s|json)$/.test(url.pathname)) continue;
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
