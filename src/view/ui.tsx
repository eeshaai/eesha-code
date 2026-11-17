/**
 * The Eesha UI library, as the panels use it.
 *
 * One place that imports it, by each component's own file rather than the
 * library's index: the index re-exports everything, including components
 * that pull in SignalR, dockview and a toast package, and esbuild would
 * have to resolve all of them. Importing file by file bundles only what
 * is named here - and only those components' stylesheets.
 */
import React from "react";

import { EmptyState } from "../../SubModules/ui-lib/src/components/primitives/EmptyState/EmptyState";
import { Icon } from "../../SubModules/ui-lib/src/components/primitives/Icon/Icon";
import type { IconProps, IconName } from "../../SubModules/ui-lib/src/components/primitives/Icon/Icon";

import { RunStatus } from "../core/models/run";
import { statusClass, statusIcon } from "./templates/statusGlyphs";

export { Button } from "../../SubModules/ui-lib/src/components/primitives/Button/Button";
export { Input } from "../../SubModules/ui-lib/src/components/primitives/Input/Input";
export { Textarea } from "../../SubModules/ui-lib/src/components/primitives/Textarea/Textarea";
export { Checkbox } from "../../SubModules/ui-lib/src/components/primitives/Checkbox/Checkbox";
export { Toggle } from "../../SubModules/ui-lib/src/components/primitives/Toggle/Toggle";
export { Tabs } from "../../SubModules/ui-lib/src/components/primitives/Tabs/Tabs";
export { StatusIndicator } from "../../SubModules/ui-lib/src/components/primitives/StatusIndicator/StatusIndicator";
export { default as ResizableSplit, ResizableSplitItem } from "../../SubModules/ui-lib/src/components/primitives/ResizableSplit/ResizableSplit";
export { Select } from "../../SubModules/ui-lib/src/components/primitives/Select/Select";
export { Table } from "../../SubModules/ui-lib/src/components/primitives/Table/Table";
export { PromptInput, ContextWindowButton, ProviderLine } from "../../SubModules/ui-lib/src/components/agent/PromptInput/PromptInput";
export { PromptInputProvider, usePromptInputContext } from "../../SubModules/ui-lib/src/components/agent/PromptInput/PromptInputContext";
export { ContextWindowMeter } from "../../SubModules/ui-lib/src/components/agent/ContextWindowMeter/ContextWindowMeter";
export type { ContextWindowSegment } from "../../SubModules/ui-lib/src/components/agent/ContextWindowMeter/ContextWindowMeter";
export { ThinkingBlock } from "../../SubModules/ui-lib/src/components/agent/ThinkingBlock/ThinkingBlock";
export { StepTree } from "../../SubModules/ui-lib/src/components/primitives/StepTree/StepTree";
export type { StepTreeItem } from "../../SubModules/ui-lib/src/components/primitives/StepTree/StepTree";
export { CommentBox } from "../../SubModules/ui-lib/src/components/primitives/CommentBox/CommentBox";
export { TextDiff } from "../../SubModules/ui-lib/src/components/primitives/TextDiff/TextDiff";
export type { TextDiffChange, TextDiffWords } from "../../SubModules/ui-lib/src/components/primitives/TextDiff/TextDiff";
export { ElapsedTimer } from "../../SubModules/ui-lib/src/components/agent/ElapsedTimer/ElapsedTimer";
export { PermissionPanel } from "../../SubModules/ui-lib/src/components/agent/PermissionPanel/PermissionPanel";
export { PermissionCard } from "../../SubModules/ui-lib/src/components/agent/PermissionCard/PermissionCard";
export { PermissionLevelPicker } from "../../SubModules/ui-lib/src/components/agent/PermissionLevelPicker/PermissionLevelPicker";
export { AppShell, AppHeader, AppFooter, HeaderButton, StatusDot, BarDivider, type StatusTone } from "../../SubModules/ui-lib/src/layouts/AppShell/AppShell";
export { SidePanel, clampWidth } from "../../SubModules/ui-lib/src/components/primitives/SidePanel/SidePanel";
export { SessionHeader, StatusPill } from "../../SubModules/ui-lib/src/components/agent/SessionHeader/SessionHeader";
export { PanelView, PanelHead, PanelButton, PanelBlank, PanelIcon } from "../../SubModules/ui-lib/src/components/primitives/PanelView/PanelView";
export { FileExplorer, type ExplorerRow, type ExplorerMenuItem, type OpenEditor } from "../../SubModules/ui-lib/src/components/agent/FileExplorer/FileExplorer";
export { GitPanel, type GitFileAction, type GitGroup, type GitPanelCommit, type GitPanelCommitFile, type GitPanelMenuItem, type GitPanelNote, type GitPanelOpened, type GitPanelRef, type GitPanelRepo, type GitPanelRow, type PathTreeNode } from "../../SubModules/ui-lib/src/components/agent/GitPanel/GitPanel";
export { BranchDialog, FormDialog, PickDialog, StashDialog, type BranchPick, type GitFormField } from "../../SubModules/ui-lib/src/components/agent/GitDialogs/GitDialogs";
export { SessionList, SessionDot, mostUrgent, type SessionGroup, type SessionRow, type SessionState } from "../../SubModules/ui-lib/src/components/agent/SessionList/SessionList";
export { CommandBlock as CommandBlockView, type CommandRun, type CommandFolder } from "../../SubModules/ui-lib/src/components/agent/CommandBlock/CommandBlock";
export { SegmentSwitch } from "../../SubModules/ui-lib/src/components/primitives/SegmentSwitch/SegmentSwitch";
export { EditorTabs } from "../../SubModules/ui-lib/src/components/primitives/EditorTabs/EditorTabs";
export { EditorView, EditorGap, EditorPath, ChangeLetter, ChangeTag, DiffCounts, EditorIconButton, EditorAction, EditorNote, EditorFile, EditorDiff, AskedNote, type EditorDiffText } from "../../SubModules/ui-lib/src/components/primitives/EditorView/EditorView";
export { StartPage, type StartSession, type StartCard, type StartSpec } from "../../SubModules/ui-lib/src/components/agent/StartPage/StartPage";
export { WorkspacePage as LibraryWorkspacePage, type WorkspacePageAction, type WorkspaceSpec } from "../../SubModules/ui-lib/src/components/agent/WorkspacePage/WorkspacePage";
export { SettingsFrame, ChoiceButtons, ConfirmModal } from "../../SubModules/ui-lib/src/components/primitives/SettingsFrame/SettingsFrame";
export { FeatureSettings, GeneralSettings, RuntimeSettings, SettingsIntro, StorageSettings } from "../../SubModules/ui-lib/src/components/agent/SettingsSections/SettingsSections";
export { ConnectorsPage } from "../../SubModules/ui-lib/src/components/agent/ConnectorsPage/ConnectorsPage";
export { PromptDialog as LibraryPromptDialog, type PromptDialogRequest } from "../../SubModules/ui-lib/src/components/primitives/PromptDialog/PromptDialog";
export { ShortcutsDialog as LibraryShortcutsDialog } from "../../SubModules/ui-lib/src/components/primitives/ShortcutsDialog/ShortcutsDialog";
export { Toasts as LibraryToasts, type ToastItem } from "../../SubModules/ui-lib/src/components/primitives/Toasts/Toasts";
export { FindFileDialog as LibraryFindFileDialog, type FindFileItem } from "../../SubModules/ui-lib/src/components/primitives/FindFileDialog/FindFileDialog";
export { FolderPicker as LibraryFolderPicker, type FolderPickerListing } from "../../SubModules/ui-lib/src/components/primitives/FolderPicker/FolderPicker";
export { ReviewDialog as LibraryReviewDialog } from "../../SubModules/ui-lib/src/components/agent/ReviewDialog/ReviewDialog";
export { SessionSearchDialog, type SessionSearchItem } from "../../SubModules/ui-lib/src/components/agent/SessionSearchDialog/SessionSearchDialog";
export { FolderDefaultsDialog } from "../../SubModules/ui-lib/src/components/agent/FolderDefaultsDialog/FolderDefaultsDialog";
export { Menu as LibraryMenu, type MenuEntry } from "../../SubModules/ui-lib/src/components/primitives/Menu/Menu";
export { SavedPermissionsList } from "../../SubModules/ui-lib/src/components/agent/SavedPermissionsList/SavedPermissionsList";
export { PlanStrip } from "../../SubModules/ui-lib/src/components/agent/PlanStrip/PlanStrip";
export { ChangedFiles } from "../../SubModules/ui-lib/src/components/agent/ChangedFiles/ChangedFiles";
export { TurnChangesList } from "../../SubModules/ui-lib/src/components/agent/TurnChangesList/TurnChangesList";
export { CopyButton } from "../../SubModules/ui-lib/src/components/primitives/CopyButton/CopyButton";
export { ModelRefreshButton } from "../../SubModules/ui-lib/src/components/agent/ModelRefreshButton/ModelRefreshButton";
export { ChatHistory } from "../../SubModules/ui-lib/src/components/agent/ChatHistory/ChatHistory";
export { type McpServerFormValues } from "../../SubModules/ui-lib/src/components/agent/AddMcpServerModal/AddMcpServerModal";
export { GoBackModal, type GoBackAsk } from "../../SubModules/ui-lib/src/components/agent/GoBackModal/GoBackModal";
export { UsageCard, UsageRow, UsageSection, UsageTable } from "../../SubModules/ui-lib/src/components/agent/UsageCard/UsageCard";
export { ChatIntro } from "../../SubModules/ui-lib/src/components/agent/ChatIntro/ChatIntro";
export { ChatTurn, ChatTurnText, ChatTurnNote, ChatAnswered, ChatHandoverLine, ChatRetry, ChatResume } from "../../SubModules/ui-lib/src/components/agent/ChatTurn/ChatTurn";
export { ChatProse } from "../../SubModules/ui-lib/src/components/agent/ChatProse/ChatProse";
export { ChatToolCall, ChatToolRun } from "../../SubModules/ui-lib/src/components/agent/ChatToolCall/ChatToolCall";
export { UsageButton } from "../../SubModules/ui-lib/src/components/agent/UsageButton/UsageButton";
export { SavedAnswersModal } from "../../SubModules/ui-lib/src/components/agent/SavedAnswersModal/SavedAnswersModal";
export { QuestionsPanel, QuestionType } from "../../SubModules/ui-lib/src/components/agent/QuestionsPanel/QuestionsPanel";
export type { MultiChoiceAnswer, Question, QuestionAnswer } from "../../SubModules/ui-lib/src/components/agent/QuestionsPanel/QuestionsPanel";
export { ToolPanel } from "../../SubModules/ui-lib/src/components/agent/ToolPanel/ToolPanel";
export { ToolGroup } from "../../SubModules/ui-lib/src/components/agent/ToolGroup/ToolGroup";
export type { ToolGroupItem } from "../../SubModules/ui-lib/src/components/agent/ToolGroup/ToolGroup";
export { ChatMessage } from "../../SubModules/ui-lib/src/components/agent/ChatMessage/ChatMessage";
export { UsageBar } from "../../SubModules/ui-lib/src/components/agent/UsageBar/UsageBar";
export { MessageJumpButtons } from "../../SubModules/ui-lib/src/components/agent/MessageJumpButtons/MessageJumpButtons";
export { PopoverDefaults } from "../../SubModules/ui-lib/src/components/primitives/Popover/Popover";
export { Modal } from "../../SubModules/ui-lib/src/components/primitives/Dialog/Modal";
export { Badge } from "../../SubModules/ui-lib/src/components/primitives/Badge/Badge";
export type { BadgeProps } from "../../SubModules/ui-lib/src/components/primitives/Badge/Badge";
export { ShortTime } from "../../SubModules/ui-lib/src/components/primitives/Time/ShortTime";
export { default as ClickAwayListener } from "../../SubModules/ui-lib/src/components/primitives/ClickAwayListener/ClickAwayListener";
export { CodeBlock } from "../../SubModules/ui-lib/src/components/primitives/CodeBlock/CodeBlock";
export { FormField } from "../../SubModules/ui-lib/src/components/primitives/FormField/FormField";
export { Chip } from "../../SubModules/ui-lib/src/components/primitives/Chip/Chip";
export { Progress } from "../../SubModules/ui-lib/src/components/primitives/Progress/Progress";
export { LoadingSpinner } from "../../SubModules/ui-lib/src/components/primitives/LoadingSpinner/LoadingSpinner";
export { FileTreePanel } from "../../SubModules/ui-lib/src/components/primitives/FileTreePanel/FileTreePanel";
export type { FileEntry } from "../../SubModules/ui-lib/src/components/primitives/FileTreePanel/FileTreePanel";
export { FILE_TREE_DRAG_MIME } from "../../SubModules/ui-lib/src/components/primitives/FileTreePanel/FileTreePanel";
export { FileViewer } from "../../SubModules/ui-lib/src/components/primitives/FileViewer/FileViewer";
export type { FileSelection } from "../../SubModules/ui-lib/src/components/primitives/FileViewer/FileViewer";
export { CodeDiff, type CodeDiffSection, type DiffLine } from "../../SubModules/ui-lib/src/components/primitives/CodeDiff/CodeDiff";
export { languageOf } from "../../SubModules/ui-lib/src/components/primitives/CodeDiff/codeColors";
export type { IconName };
export type { AgentModeOption, ModelOption, ProviderPart, PromptInputReference, PromptInputAttachment, ToolOption, McpServerOption, MentionMenuItem, PromptCommandOption, FileMentionOption, PathMentionOption, GrammarChecker, GrammarSuggestion } from "../../SubModules/ui-lib/src/components/agent/PromptInput/PromptInput";
export type { ToolSelection } from "../../SubModules/ui-lib/src/components/agent/PromptInput/PromptInputContext";

/**
 * A pane or tab with nothing in it yet, as the library's EmptyState.
 *
 * The panels' empty texts are one sentence, most of them "What - why"
 * ("Nothing yet - runs of this workflow show up here once it has run").
 * The part before " - " (or before the first full stop) becomes the
 * title and the rest the description, so a call site passes one sentence.
 */
export function EmptyNote({ text, icon = "inbox", className }: { text: string; icon?: IconName; className?: string }) {

    const [title, rest] = splitNote(text);

    return (
        <EmptyState
            icon={icon}
            title={title}
            description={rest}
            className={"empty-note" + (className ? " " + className : "")} />
    );
}

/** "What - why" or "What. Why." into its two parts; a text with neither is all title. */
export function splitNote(text: string): [string, string | undefined] {

    const trimmed = text.trim();

    const dash = trimmed.indexOf(" - ");
    const stop = trimmed.search(/\.\s/);

    const cut = dash >= 0 ? dash : stop;

    if (cut < 0)
        return [trimmed.replace(/\.$/, ""), undefined];

    const rest = trimmed.slice(cut + (dash >= 0 ? 3 : 1)).trim();

    return [trimmed.slice(0, cut).replace(/\.$/, ""), rest.charAt(0).toUpperCase() + rest.slice(1)];
}

/**
 * An icon that is only decoration, in a span the panels style by its
 * class. The button's own text or aria-label names it. `variant` picks the
 * stroked (default) or filled drawing.
 */
export function UiIcon({ name, size = "sm", variant, className }: {
    name: IconName;
    size?: IconProps["size"];
    variant?: IconProps["variant"];
    className?: string;
}) {

    return (
        <span className={"ui-icon" + (className ? " " + className : "")} aria-hidden="true">
            <Icon iconName={name} size={size} variant={variant} />
        </span>
    );
}

/** The library Badge colour for a run status. */
export function statusBadge(status: RunStatus): "secondary" | "info" | "success" | "danger" | "warning" {

    switch (status) {
        case RunStatus.Running: return "info";
        case RunStatus.Success: return "success";
        case RunStatus.Failed: return "danger";
        case RunStatus.Waiting: return "warning";
        default: return "secondary";
    }
}

/**
 * A step's or run's status as a coloured, filled icon. `gate` marks a
 * step not reached yet that will stop for approval, so it is known before
 * Run is pressed.
 */
export function StatusIcon({ status, gate = false, size = "sm", className }: {
    status: RunStatus;
    gate?: boolean;
    size?: IconProps["size"];
    className?: string;
}) {

    const pendingGate = gate && status === RunStatus.Pending;
    const name = pendingGate ? "gate-ahead" : statusIcon(status);
    const tone = pendingGate ? "waiting" : statusClass(status);

    return <UiIcon name={name} size={size} variant="filled" className={`status-icon status-icon--${tone}` + (className ? " " + className : "")} />;
}
