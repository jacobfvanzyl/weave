/// Pencil proximity has priority over fingers, including a resting palm. Leaving
/// hover does not itself change modes: only a fresh, eligible finger contact does.
public struct InputTool: Sendable {
    public enum Mode: Sendable { case finger, pencil }
    public private(set) var mode = Mode.finger
    public private(set) var hovering = false
    public private(set) var pencilDown = false
    private var fingers: Set<Int> = []
    private var acceptedFingers: Set<Int> = []
    public init() {}
    public mutating func hover(_ inRange: Bool) {
        hovering = inRange
        if inRange { selectPencil() }
    }
    public mutating func beginPencil() { pencilDown = true; selectPencil() }
    public mutating func endPencil() { pencilDown = false }
    private mutating func selectPencil() { mode = .pencil; acceptedFingers.removeAll() }
    public mutating func beginFingers(_ ids: [Int]) -> [Int] {
        let hadUnacceptedContacts = !fingers.subtracting(acceptedFingers).isEmpty
        fingers.formUnion(ids)
        guard !hovering, !pencilDown, !hadUnacceptedContacts else { return [] }
        mode = .finger
        acceptedFingers.formUnion(ids)
        return ids
    }
    public func accepts(_ id: Int) -> Bool { mode == .finger && acceptedFingers.contains(id) }
    public mutating func endFingers(_ ids: [Int]) {
        fingers.subtract(ids); acceptedFingers.subtract(ids)
    }
    /// Mapping/geometry changes cancel recognition without turning held fingers
    /// into new contacts or forgetting whether a physical Pencil is still down.
    public mutating func interrupt() { acceptedFingers.removeAll() }
}
