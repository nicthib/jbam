function getConnectedComponents(nodes, edges) {
  const adj = {};
  nodes.forEach((n) => (adj[n.id] = []));
  edges.forEach((edge) => {
    if (adj[edge.from] && adj[edge.to]) {
      adj[edge.from].push(edge.to);
      adj[edge.to].push(edge.from);
    }
  });
  const visited = new Set();
  const components = [];
  nodes.forEach((node) => {
    if (!visited.has(node.id)) {
      const comp = [];
      const stack = [node.id];
      while (stack.length) {
        const current = stack.pop();
        if (!visited.has(current)) {
          visited.add(current);
          comp.push(current);
          adj[current].forEach((nbr) => {
            if (!visited.has(nbr)) stack.push(nbr);
          });
        }
      }
      components.push(comp);
    }
  });
  return components;
}

const getNodeColor = (nodeId, connections) => {
  if (graphData.open_slot_nodes && graphData.open_slot_nodes.includes(nodeId)) {
    return "#FF0000";
  }
  if (connections > 3) return "#800080";
  if (connections === 3) return "#800080";
  if (connections === 2) return "#bd7900";
  if (connections === 1) return "#2B7CE9";
  return "#808080";
};

// Fetches the entire graph from the Flask backend
const fetchGraphData = () => {
  fetch("/api/graph",{credentials: "include"})
    .then((res) => res.json())
    .then((data) => {
      setGraphData(data);
      setItems(data.items || []);
      setStatusMessage(data.status_message || "");
    })
    .catch((err) => console.error("Error fetching graph:", err));
};

// Helper function to compute the degree (number of connections) for a node
const getDegree = (nodeId) => {
  let degree = 0;
  allEdges.forEach((edge) => {
    if (edge.from === nodeId || edge.to === nodeId) {
      degree++;
    }
  });
  return degree;
};

const keyDownHandler = (event) => {
  if (event.key === "Enter") {
    if (!pendingEdgeRef.current) {
       // First Enter: set the source node if one is hovered.
       if (currentHoveredNode) {
            pendingEdgeRef.current = currentHoveredNode;
            console.log(`Edge initiation: source node ${currentHoveredNode}`);
       }
    } else {
       // Second Enter: if a  node is hovered, that becomes the target.
       if (currentHoveredNode && currentHoveredNode !== pendingEdgeRef.current) {
            setPendingCustomEdge({ source: pendingEdgeRef.current, target: currentHoveredNode });
            setShowCustomModal(true);
       } else {
            console.log("No valid target selected, cancelling custom edge.");
       }
       pendingEdgeRef.current = null;
    }
  }
};

// Add item by sending to the backend
const addItem = () => {
  if (!newItem.trim()) return;
  fetch("/api/add_item", {
    method: "POST",
    body: JSON.stringify({ item: newItem }),
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  })
    .then(() => fetchGraphData())
    .catch((err) => console.error("Error adding item:", err));
};

// Remove an item
const removeItem = (itemId) => {
  fetch("/api/remove_item", {
    method: "POST",
    body: JSON.stringify({ item: itemId }),
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  })
    .then(() => fetchGraphData())
    .catch((err) => console.error("Error removing item:", err));
};

// Handle toggling the active state for the selected node
const handleToggleActive = () => {
  fetch("/api/toggle_item", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: selectedNode.uid, active: !selectedNode.active }),
    credentials: "include",
  })
    .then(() => {
      fetchGraphData();
      setSelectedNode({ ...selectedNode, active: !selectedNode.active });
    })
    .catch((err) => console.error("Error toggling active state:", err));
};

const renderHelpModal = () => (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 10000,
      }}
    >
      <div
        style={{
          backgroundColor: "#fff",
          border: "1px solid #ddd",
          borderRadius: "8px",
          width: "80%",
          maxWidth: "600px",
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            left: 0,
            backgroundColor: "#fff",
            zIndex: 10,
            padding: "10px 20px",
            borderBottom: "1px solid #ddd",
            display: "flex",
            alignItems: "center",
          }}
        >
          <button
            onClick={() => setShowHelp(false)}
            style={{
              backgroundColor: "red",
              color: "white",
              border: "none",
              borderRadius: "50%",
              width: "30px",
              height: "30px",
              fontSize: "18px",
              fontWeight: "bold",
              cursor: "pointer",
              marginRight: "15px",
              marginLeft: "-5px",
              flexShrink: 0,
            }}
          >
            <svg width="24" height="24" viewBox="1 -1 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" >
              <line x1="4" y1="7" x2="16" y2="19" stroke="white" strokeWidth="4"/>
              <line x1="16" y1="7" x2="4" y2="19" stroke="white" strokeWidth="4"/>
            </svg>
          </button>
          <h2 style={{ margin: 0 }}>Help & Information</h2>
        </div>
        <div style={{ padding: "20px" }}>
          <p>
            <strong>Node Colors:</strong>
          </p>
          <ul>
            <li>
              <strong>
                <span style={{ color: "#FF0000" }}>Red</span>
              </strong>
              : Parts with missing components.
            </li>
            <li>
              <strong>
                <span style={{ color: "#800080" }}>Purple</span>
              </strong>
              : Parts with 3 or more connections.
            </li>
            <li>
              <strong>
                <span style={{ color: "#bd7900" }}>Orange</span>
              </strong>
              : Parts with 2 connections.
            </li>
            <li>
              <strong>
                <span style={{ color: "#2B7CE9" }}>Blue</span>
              </strong>
              : Parts with 1 connection.
            </li>
            <li>
              <strong>
                <span style={{ color: "#808080" }}>Gray</span>
              </strong>
              : Parts with no connections.
            </li>
          </ul>
          <p>
            <strong>Ghost Parts:</strong> These represent parts that are included
            with other parts (i.e., an LLG that comes with a Sola). They are
            displayed with a dotted border to help you differentiate them from
            regular parts. Promo packages are entirely composed of Ghost Parts.

            NOTE: Ghost parts are always replaced by equivalent parts in a quote if they are added.
          </p>
          <p>
            <strong>Search:</strong> Use the search bar to find and add parts by
            entering their ID or description. Matching results will be shown in a
            dropdown, and can be directly added by clicking the + icon.
          </p>
          <p>
            <strong>Clear All:</strong> Clears all items from the graph.
          </p>
          <p>
            <strong>Suggestions:</strong> When you click on a part in the graph,
            suggestions for connecting parts will be shown (if any are available).
            You can add a suggested part directly from there.
          </p>
          <p>
            <strong>Hiding parts:</strong> Right clicking any node will hide all 
            "dead end" nodes conected to it (i.e. blue nodes). This can help reduce clutter on the graph.
          </p>
          <p>
            <strong>Custom connections:</strong> If two parts should be connected, hover over each part 
            and press spacebar. A dialog box will appear giving you the option of how you want to connect them. 
            This only works if at least one of the parts has an available slot. WARNING: This action cannot be undone
          </p>
        </div>
      </div>
    </div>
  );


export {
  getConnectedComponents,
  getNodeColor,
  fetchGraphData,
  getDegree,
  keyDownHandler,
  addItem,
  removeItem,
  handleToggleActive,
  renderHelpModal,
};