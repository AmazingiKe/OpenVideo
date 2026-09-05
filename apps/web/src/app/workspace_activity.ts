import { createContext } from "react";

// 工作区保留实例时，隐藏页面必须停用播放和全局交互；独立组件默认可交互。
export const WorkspaceActiveContext = createContext(true);
