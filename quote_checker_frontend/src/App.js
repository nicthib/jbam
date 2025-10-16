import React, { useEffect, useState, useRef } from "react";
import { Network } from "vis-network/standalone";
import './App.css';
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
export default function NetworkGraph() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [password, setPassword] = useState("");
  const [items, setItems] = useState([]);
  const [newItem, setNewItem] = useState("");
  const [partDB, setPartDB] = useState([]);
  const [graphData, setGraphData] = useState({ nodes: [], edges: [], empty_slots: [] });
  const [showDropdown, setShowDropdown] = useState(false);
  const visNetworkRef = useRef(null);
  const networkRef = useRef(null);
  const positionsRef = useRef({});
  const [statusMessage, setStatusMessage] = useState("");
  const [selectedNode, setSelectedNode] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [filteredParts, setFilteredParts] = useState([]);
  const [showHelp, setShowHelp] = useState(false);
  const [suggestionType, setSuggestionType] = useState("all parts");
  const initialGraphSetup = useRef(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [pendingCustomEdge, setPendingCustomEdge] = useState(null);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [availableSlots, setAvailableSlots] = useState([]);
  const pendingEdgeRef = useRef(null);
  let currentHoveredNode = null;
  const [suggestionSearch, setSuggestionSearch] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const normalize = (str) =>
    str.replace(/[\s-]/g, "").toLowerCase();
  const handleLogin = () => {
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      credentials: "include"
    })
      .then(response => {
        if (response.ok) {
          setIsLoggedIn(true);
        } else {
          alert("Invalid password");
        }
      })
      .catch(error => {
        console.error("Login error:", error);
        alert("An error occurred during login");
      });
  };
  const filteredSuggestions = Object.keys(suggestions).reduce((acc, slotName) => {
    const filtered = suggestions[slotName].filter(
      (part) =>
        part.ID.toLowerCase().includes(suggestionSearch.toLowerCase()) ||
        part.Name.toLowerCase().includes(suggestionSearch.toLowerCase())
    );
    if (filtered.length > 0) {
      acc[slotName] = filtered;
    }
    return acc;
  }, {});

  const totalSuggestionsCount = Object.values(suggestions).reduce(
    (acc, arr) => acc + arr.length,
    0
  );
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

  // Initial data fetch (graph + parts database)
  useEffect(() => {
    if (isLoggedIn) {
      // Fetch graph data
      fetch("/api/graph", { credentials: "include" })
        .then((res) => res.json())
        .then((data) => {
          setGraphData(data);
          setItems(data.items || []);
          setStatusMessage(data.status_message || "");
        })
        .catch((err) => console.error("Error fetching graph:", err));

      // Fetch parts database
      fetch("/api/parts", { credentials: "include" })
        .then((res) => res.json())
        .then((data) => setPartDB(data))
        .catch((err) => console.error("Error fetching parts:", err));
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (showCustomModal && pendingCustomEdge) {
      Promise.all([
        fetch("/api/suggest_parts", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ node_name: pendingCustomEdge.source, suggestion_type: "all parts" }),
           credentials: "include"
        }).then(res => res.json()),
        fetch("/api/suggest_parts", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ node_name: pendingCustomEdge.target, suggestion_type: "all parts" }),
           credentials: "include"
        }).then(res => res.json())
      ])
      .then(([data1, data2]) => {
        const slotsSet = new Set();
        if (data1.suggestions) {
           Object.keys(data1.suggestions).forEach(key => slotsSet.add(key));
        }
        if (data2.suggestions) {
           Object.keys(data2.suggestions).forEach(key => slotsSet.add(key));
        }
        setAvailableSlots(Array.from(slotsSet));
      })
      .catch(err => console.error("Error fetching missing slots:", err));
    }
  }, [showCustomModal, pendingCustomEdge]);

  // Update node and edge visibility when selectedGroup changes.
  useEffect(() => {
    if (visNetworkRef.current) {
      const nodesDataSet = visNetworkRef.current.body.data.nodes;
      const edgesDataSet = visNetworkRef.current.body.data.edges;
      const allNodes = nodesDataSet.get();
      
      // Determine allowed tags based on the selected group.
      let allowedTags = [];
      if (selectedGroup === "Interlock") {
        allowedTags = ["Interlock", "LaserSafety"];
      } else if (selectedGroup === "Triggering") {
        allowedTags = ["Triggering", "BNC"];
      }
      
      // Update nodes: if no group is selected, show all nodes;
      // otherwise, show only nodes that have at least one allowed tag.
      allNodes.forEach((node) => {
        const nodeTags = node.tags || [];
        const shouldShow =
          selectedGroup === "" ||
          nodeTags.some((tag) => allowedTags.includes(tag));
        nodesDataSet.update({ id: node.id, hidden: !shouldShow });
      });
      
      // Update edges: show an edge only if both endpoints are visible.
      const allEdges = edgesDataSet.get();
      allEdges.forEach((edge) => {
        const fromNode = nodesDataSet.get(edge.from);
        const toNode = nodesDataSet.get(edge.to);
        const edgeShouldShow = fromNode && toNode && !fromNode.hidden && !toNode.hidden;
        edgesDataSet.update({ id: edge.id, hidden: !edgeShouldShow });
      });
      visNetworkRef.current.redraw();
      console.log("Filtered nodes with group:", selectedGroup);
    }
  }, [selectedGroup]);

  // Initialize Vis.js network graph every time graphData changes
  useEffect(() => {
    if (!networkRef.current) return;
    if (graphData.nodes.length === 0) {
      networkRef.current.innerHTML = "";
      return;
    }

    console.log("Initializing Network with data:", graphData);
    // Reapply saved positions and hidden state if available.
    graphData.nodes.forEach((node) => {
      const saved = positionsRef.current[node.id];
      if (saved) {
        node.x = saved.x;
        node.y = saved.y;
        if (saved.hidden) {
          node.hidden = true;
        }
      }
    });
    const edgeCounts = {};
    graphData.edges.forEach((edge) => {
      edgeCounts[edge.from] = (edgeCounts[edge.from] || 0) + 1;
      edgeCounts[edge.to] = (edgeCounts[edge.to] || 0) + 1;
    });

    const connectedNodes = new Set(graphData.edges.flatMap((edge) => [edge.from, edge.to]));
    const orphanNodes = graphData.nodes.filter((node) => !connectedNodes.has(node.id));
    const nonOrphanNodes = graphData.nodes.filter((node) => connectedNodes.has(node.id));
    const isFreshLoad = !initialGraphSetup.current;
    if (!initialGraphSetup.current && graphData.nodes.length) {
      const groupSpacingX = 2000;
      const groupSpacingY = 1000;
      const localSpacing = 200;
      const groups = [];
      if (orphanNodes.length > 0) {
        groups.push({ nodes: orphanNodes, orphan: true });
      }
      const components = getConnectedComponents(nonOrphanNodes, graphData.edges);
      components.forEach((comp) => {
        const compNodes = graphData.nodes.filter((node) => comp.includes(node.id));
        groups.push({ nodes: compNodes, orphan: false });
      });
      const totalGroups = groups.length;
      const gridSize = Math.ceil(Math.sqrt(totalGroups));
      groups.forEach((group, groupIndex) => {
        const col = groupIndex % gridSize;
        const row = Math.floor(groupIndex / gridSize);
        const groupOriginX = col * groupSpacingX;
        const groupOriginY = row * groupSpacingY;
        if (group.orphan) {
          group.nodes.forEach((node, index) => {
            node.x = groupOriginX + (index % 3) * localSpacing;
            node.y = groupOriginY + Math.floor(index / 3) * localSpacing;
          });
        } else {
          group.nodes.forEach((node) => {
            node.x = groupOriginX;
            node.y = groupOriginY;
          });
        }
      });
      initialGraphSetup.current = true;
    }

    orphanNodes.forEach((node, index) => {
      node.physics = false;    
    });
            
    // Color logic for nodes
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

    // Combine orphan & non-orphan nodes for final positioning.
    // Also, pass along any hidden state.
    const positionedNodes = [...nonOrphanNodes, ...orphanNodes].map((node) => {
      const connections = edgeCounts[node.id] || 0;
      const hiddenFlag = node.hidden || false;
       if (!node.active) {
        return {
          ...node,
          hidden: hiddenFlag,
          color: {
            background: "#D3D3D3",
            border: "#666",
            highlight: { background: "#D3D3D3", border: "#666" },
            hover: { background: "#bbb", border: "#666" },
          },
          opacity: 0.5,
          shape: "box",
          shapeProperties: node.ghost ? { borderDashes: [12, 12] } : {},
          font: {
            multi: true,
            size: 14,
            color: "#666",
            face: "Arial",
            bold: true,
          },
          borderWidth: 2,
          widthConstraint: { maximum: 120 },
          heightConstraint: { minimum: 40 },
          margin: 10
        };
      }
      return {
        ...node,
        hidden: hiddenFlag,
        color: {
          background: getNodeColor(node.id, connections),
          border: "#000",
          highlight: { background: "#000", border: "#000" },
          hover: { background: "#333", border: "#000" },
        },
        shape: "box",
        shapeProperties: node.ghost ? { borderDashes: [12, 12] } : {},
        font: {
          multi: true,
          size: 14,
          color: "#FFF",
          face: "Arial",
          bold: true,
        },
        borderWidth: 2,
        widthConstraint: { maximum: 120 },
        heightConstraint: { minimum: 40 },
        margin: 10
      };
    });

    // Create the network
    const network = new Network(
      networkRef.current,
      { nodes: positionedNodes, edges: graphData.edges },
      {
        layout: { improvedLayout: true, hierarchical: false },
        edges: { color: "#848484", width: 2, smooth: { type: "continuous" },arrowStrikethrough: false, arrows: {to: { enabled: true, type: "arrow" }}},
        physics: {
          enabled: true,
          barnesHut: {
            gravitationalConstant: isFreshLoad ? -30000 : -1500,
            springLength: 200,
            springConstant: 0.04,
            centralGravity: 0.00
          },
          stabilization: { enabled: true, iterations: 200 },
        },
        interaction: {
          hover: true,
          tooltipDelay: 50,
          hideEdgesOnDrag: false,
          hoverConnectedEdges: true,
        },
      }
    );
    visNetworkRef.current = network;
    if (isFreshLoad) {
      setTimeout(() => {
        network.setOptions({
          physics: {
            barnesHut: {
              gravitationalConstant: -1500,
            },
          },
        });
        network.fit({
          animation: {
            duration: 500,
            easingFunction: "easeInOutQuad"
          }
        });
      }, 1000);
    } else {
      // Otherwise, just enforce –1500 immediately.
      network.setOptions({
        physics: {
          barnesHut: {
            gravitationalConstant: -1500,
          },
        },
      });
    }
   
    // Update positionsRef to also store hidden state.
    network.on('stabilized', () => {
      const newPositions = network.getPositions();
      const currentNodes = network.body.data.nodes.get();
      currentNodes.forEach((node) => {
         if (node.hidden) {
           newPositions[node.id] = { ...newPositions[node.id], hidden: true };
         }
      });
      positionsRef.current = newPositions;
      console.log('Network Saved!');
    });
    network.on('dragEnd', () => {
      const newPositions = network.getPositions();
      const currentNodes = network.body.data.nodes.get();
      currentNodes.forEach((node) => {
         if (node.hidden) {
           newPositions[node.id] = { ...newPositions[node.id], hidden: true };
         }
      });
      positionsRef.current = newPositions;
      console.log('Network Saved!');
    });
    network.on("oncontext", (params) => {
      params.event.preventDefault();
      const clickedNodeId = network.getNodeAt(params.pointer.DOM);
      if (!clickedNodeId) return; // Exit if no node was clicked

      // Get connected node IDs for the clicked node
      const connectedNodeIds = network.getConnectedNodes(clickedNodeId);
      // Get all edges from the network's DataSet for degree calculation
      const allEdges = network.body.data.edges.get();

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

      connectedNodeIds.forEach((nodeId) => {
          if (getDegree(nodeId) === 1) {
            const nodeData = network.body.data.nodes.get(nodeId);
            const newHidden = !nodeData.hidden;
            network.body.data.nodes.update({
              id: nodeId,
              hidden: newHidden,
            });
          }
        });
    });

    network.on("click", (params) => {
      if (params.event && params.event.srcEvent && params.event.srcEvent.buttons !== 0) {
        return;
      }
      if (params.nodes.length > 0) {
        const clickedNodeId = params.nodes[0];
        const clickedNode = graphData.nodes.find(n => n.id === clickedNodeId);
        const allSidebarItems = document.querySelectorAll("ul li span");
        for (const span of allSidebarItems) {
          // Normalize both strings for comparison
          if (span.textContent.includes(clickedNode.label)) {
            span.scrollIntoView({ behavior: "smooth", block: "center" });
            span.classList.add("highlighted-item");
            break;
          }
        }
        fetch("/api/suggest_parts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_name: clickedNodeId, suggestion_type: suggestionType }),
          credentials: "include",
        })
          .then((res) => res.json())
          .then((data) => {
            setSelectedNode(clickedNode);
            setSuggestionSearch("");
            setSuggestions(data.suggestions);
          })
          .catch((err) => console.error("Error fetching suggestions:", err));
      } else {
        setSelectedNode(null);
        setSuggestions([]);
      }

      
    });
    network.once("stabilized", () => {
      const updatedPositions = network.getPositions();
      positionsRef.current = updatedPositions;
      console.log('Network Saved!');
    });
    network.on("afterDrawing", (ctx) => {
      // Loop through each node from the current graphData
      graphData.nodes.forEach((node) => {
        // Get the most up-to-date data for this node
        const nodeData = network.body.data.nodes.get(node.id);
        // Only draw badges if the node is visible
        if (!nodeData.hidden) {
          // Draw the merged badge ("x badge") if it exists and badgeCount > 1
          if (node.badgeCount && node.badgeCount > 1) {
            const box = network.getBoundingBox(node.id);
            const badgeRadius = 15;
            // Place the x badge in the top-right corner
            const circleX = box.right - 5;
            const circleY = box.top + 5;
            ctx.beginPath();
            ctx.arc(circleX, circleY, badgeRadius, 0, 2 * Math.PI);
            ctx.fillStyle = "#666";
            ctx.fill();
            ctx.closePath();
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.font = "bold 12px Arial";
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`x${node.badgeCount}`, circleX, circleY);
          }

          // Check for any hidden nodes connected to this node
          const connectedNodeIds = network.getConnectedNodes(node.id);
          let hiddenCount = 0;
          connectedNodeIds.forEach((id) => {
            const connectedNode = network.body.data.nodes.get(id);
            if (connectedNode && connectedNode.hidden) {
              hiddenCount++;
            }
          });
          // If any connected nodes are hidden, draw a plus badge at the bottom-right
          if (hiddenCount > 0) {
            const box = network.getBoundingBox(node.id);
            const badgeRadius = 15;
            const circleX = box.right - 5;
            const circleY = box.bottom - 5;
            ctx.beginPath();
            ctx.arc(circleX, circleY, badgeRadius, 0, 2 * Math.PI);
            ctx.fillStyle = "#006600";
            ctx.fill();
            ctx.closePath();
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.font = "bold 24px Arial";
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("+", circleX, circleY);
          }
        }
      });
    });

    network.on("hoverNode", (params) => {
      currentHoveredNode = params.node;
    });
  
  network.on("blurNode", (params) => {
    // Only clear if no edge is pending
    if (!pendingEdgeRef.current) {
      currentHoveredNode = null;
    }
    document.querySelectorAll(".highlighted-item").forEach(el => {
    el.classList.remove("highlighted-item");
  });
  });
  
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
  
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });
  document.addEventListener("keydown", keyDownHandler);
  return () => {
    document.removeEventListener("keydown", keyDownHandler);
    network.off("hoverNode");
    network.off("blurNode");
  };

    setTimeout(() => {
      positionsRef.current = network.getPositions();
    }, 500);
  }, [graphData]);


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
              : Parts with missing components
            </li>
            <li>
              <strong>
                <span style={{ color: "#800080" }}>Purple</span>
              </strong>
              : Parts with 3 or more connections
            </li>
            <li>
              <strong>
                <span style={{ color: "#bd7900" }}>Orange</span>
              </strong>
              : Parts with 2 connections
            </li>
            <li>
              <strong>
                <span style={{ color: "#2B7CE9" }}>Blue</span>
              </strong>
              : Parts with 1 connection
            </li>
            <li>
              <strong>
                <span style={{ color: "#808080" }}>Gray</span>
              </strong>
              : Parts with no connections
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
            and press enter. A dialog box will appear giving you the option of how you want to connect them. 
            This only works if at least one of the parts has an available slot. WARNING: This action cannot be undone
          </p>
        </div>
      </div>
    </div>
  );

  useEffect(() => {
    if (selectedNode) {
      fetch("/api/suggest_parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_name: selectedNode.id, suggestion_type: suggestionType }),
        credentials: "include",
      })
        .then((res) => res.json())
        .then((data) => setSuggestions(data.suggestions))
        .catch((err) => console.error("Error fetching suggestions:", err));
    }
  }, [suggestionType, selectedNode]);

  if (!isLoggedIn) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      backgroundColor: "#F4F4F4"
    }}>
      <input
        type="password"
        placeholder="Enter password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleLogin();
          }
        }}
        style={{
          padding: "10px",
          fontSize: "16px",
          marginBottom: "10px",
          width: "200px"
        }}
      />
      <button
        onClick={handleLogin}
        style={{
          padding: "10px 20px",
          fontSize: "16px",
          cursor: "pointer"
        }}
      >
        Login
      </button>
    </div>
  );
}

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#F4F4F4" }}>
      <button
        onClick={() => setShowHelp(true)}
        style={{
          position: "absolute",
          top: "20px",
          left: "30px",
          zIndex: 11000,
          background: "none",
          border: "none",
          color: "grey",
          fontSize: "90px",
          fontWeight: "bold",
          cursor: "pointer",
          padding: 0,
          margin: 0
        }}
      >
        ?
      </button>
      <div
        ref={networkRef}
        style={{
          flex: 3,
          height: "100%",
          border: "1px solid #ddd",
          margin: "10px",
          backgroundColor: "white",
          borderRadius: "8px",
          padding: "10px",
        }}
      />
      <div
        style={{
          flex: 1,
          padding: "15px",
          border: "1px solid #ddd",
          backgroundColor: "white",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div style={{ width: "100%", position: "relative", marginBottom: "10px" }}>
          <input
            value={newItem}
            onChange={(e) => {
              const searchValue = e.target.value;
              setNewItem(searchValue);
              if (!searchValue.trim()) {
                setShowDropdown(false);
                setFilteredParts([]);
                return;
              }
              const normQuery = normalize(searchValue);
              const results = partDB.filter((part) => {
                const normId = normalize(part.id);
                const normDesc = normalize(part.description);
                return normId.includes(normQuery) || normDesc.includes(normQuery);
              });
              setFilteredParts(results);
              setShowDropdown(results.length > 0);
            }}
            placeholder="Search or enter Item ID"
            style={{
              width: "90%",
              padding: "10px",
              borderRadius: "5px",
              border: "1px solid #ccc",
            }}
          />

          {showDropdown && (
            <div
              style={{
                position: "absolute",
                width: "100%",
                backgroundColor: "white",
                border: "1px solid #ddd",
                borderRadius: "5px",
                zIndex: 10,
                maxHeight: "450px",
                overflowY: "auto",
                boxShadow: "0px 4px 6px rgba(0, 0, 0, 0.1)",
              }}
              role="listbox"
            >
              {filteredParts.length > 0 ? (
                filteredParts.map((part) => (
                  <div
                    key={part.id}
                    style={{
                      padding: "10px",
                      borderBottom: "1px solid #ddd",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                    role="option"
                  >
                    <span
                      onClick={() => {
                        setNewItem(part.id);
                        setShowDropdown(false);
                      }}
                      style={{
                        cursor: "pointer",
                        flexGrow: 1,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      <strong>{part.id}</strong>: {part.description}
                    </span>
                    <button
                      onClick={() => {
                        setNewItem(part.id);
                        fetch("/api/add_item", {
                          method: "POST",
                          body: JSON.stringify({ item: part.id }),
                          headers: { "Content-Type": "application/json" },
                          credentials: "include",
                        })
                          .then(() => {
                            fetchGraphData();
                          })
                          .catch((err) => console.error("Error adding item:", err));
                        setShowDropdown(false);
                      }}
                      style={{
                        marginLeft: "5px",
                        padding: "2px 5px",
                        backgroundColor: "#4CAF50",
                        color: "#fff",
                        border: "none",
                        borderRadius: "3px",
                        cursor: "pointer",
                      }}
                    >
                      +
                    </button>
                  </div>
                ))
              ) : (
                <div style={{ padding: "10px" }}>No results found</div>
              )}
            </div>
          )}
        </div>
        {/* Fixed Group Radio Buttons */}
        <div style={{ display: "flex", gap: "20px", marginBottom: "10px" }}>
          <label>
            <input
              type="radio"
              name="groupFilter"
              value="Interlock"
              checked={selectedGroup === "Interlock"}
              onClick={() =>
                setSelectedGroup(selectedGroup === "Interlock" ? "" : "Interlock")
              }
            />
            Isolate Interlock
          </label>
          <label>
            <input
              type="radio"
              name="groupFilter"
              value="Triggering"
              checked={selectedGroup === "Triggering"}
              onClick={() =>
                setSelectedGroup(selectedGroup === "Triggering" ? "" : "Triggering")
              }
            />
            Isolate Triggering
          </label>
        </div>
        <div style={{ display: "flex", width: "50%", gap: "10px", marginBottom: "10px" }}>
          <button
            onClick={() => {
              fetch("/api/clear", { method: "POST",credentials: "include",})
                .then(() => {
                  fetchGraphData();
                  document.cookie = "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
                })
                .then((res) => res.json())
                .then((data) => {
                  initialGraphSetup.current = false;
                  setGraphData({ nodes: [], edges: [] });
                  setItems([]);
                  setTimeout(() => {
                    setGraphData(data);
                  }, 200);
                })
                .catch((err) => console.error("Error clearing graph:", err));
            }}
            style={{
              flex: 1,
              padding: "10px",
              backgroundColor: "red",
              color: "white",
              border: "none",
              borderRadius: "5px",
            }}
          >
            Clear
          </button>
          <button
  onClick={() => {
    fetch("/api/save", { method: "POST", credentials: "include" })
      .then(response => response.blob())
      .then(blob => {
        // Create a URL for the Blob object
        const url = window.URL.createObjectURL(blob);
        // Create a temporary link element
        const a = document.createElement('a');
        a.href = url;
        a.download = "notebook.txt"; // Set the file name for download
        document.body.appendChild(a);
        a.click();
        // Clean up: remove the element and revoke the object URL
        a.remove();
        window.URL.revokeObjectURL(url);
      })
      .catch((err) => console.error("Error saving:", err));
  }}
  style={{
    flex: 1,
    padding: "10px",
    backgroundColor: "green",
    color: "white",
    border: "none",
    borderRadius: "5px",
  }}
>
  Save
</button>


        </div>
        <input
          type="file"
          accept=".pdf,.xls,.xlsx"
          onChange={(event) => {
            initialGraphSetup.current = false;
            const file = event.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append("file", file);
            fetch("/api/load_pdf", {
              method: "POST",
              body: formData,
              credentials: "include",
            })
              .then((res) => res.json())
              .then((data) => {
                setGraphData(data);
                setItems(data.items || []);
              })
              .catch((err) => console.error("Error uploading PDF:", err));
          }}
          style={{ marginBottom: "15px" }}
        />

        <ul
          style={{
            listStyleType: "none",
            padding: 0,
            width: "100%",
            maxHeight: "1000px",
            overflowY: "auto",
            borderTop: "1px solid #ddd",
          }}
        >
          {items.map((item, idx) => (
            <React.Fragment key={`${item.id}-${idx}`}>
              <li
                style={{
                  padding: "8px",
                  borderBottom: "1px solid #ddd",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>
                  <strong>{item.id}</strong>: {item.description}
                </span>
                <button
                  onClick={() => removeItem(item.id)}
                  style={{
                    color: "red",
                    cursor: "pointer",
                    border: "none",
                    background: "none",
                    fontSize: "16px",
                  }}
                >
                  X
                </button>
              </li>

              {(item.ghosts || []).map((g, gIdx) => (
                <li
                  key={`${item.id}-ghost-${g.id}-${gIdx}`}
                  style={{
                    padding: "8px",
                    borderBottom: "1px solid #eee",
                    color: "#888",
                    marginLeft: "15px",
                  }}
                >
                  <span>
                    <strong>{g.id}</strong>: {g.description}
                  </span>
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>
        {selectedNode && (
  <div
    style={{
      position: "fixed",
      top: 0,
      left: 0,
      width: "100vw",
      height: "100vh",
      backgroundColor: "rgba(0, 0, 0, 0.4)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 9999,
    }}
  >
    <div
      style={{
        backgroundColor: "#fff",
        border: "1px solid #ddd",
        borderRadius: "5px",
        width: "700px",
        maxHeight: "80vh",
        overflowY: "auto",
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.2)",
        position: "relative",
      }}
    >
      {/* Modal Header */}
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
          onClick={() => {
            setSelectedNode(null);
            setSuggestions({});
          }}
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
          <svg
            width="24"
            height="24"
            viewBox="1 -1 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <line x1="4" y1="7" x2="16" y2="19" stroke="white" strokeWidth="4" />
            <line x1="16" y1="7" x2="4" y2="19" stroke="white" strokeWidth="4" />
          </svg>
        </button>
        <h4 style={{ margin: 0 }}>Suggestions for {selectedNode.label}</h4>
      </div>
      <div style={{ padding: "20px" }}>
        {/* Conditionally show the Search Bar if there are 10 or more suggestions */}
        {totalSuggestionsCount >= 10 && (
          <input
            type="text"
            placeholder="Search suggestions..."
            value={suggestionSearch}
            onChange={(e) => setSuggestionSearch(e.target.value)}
            style={{
              width: "100%",
              padding: "8px",
              marginBottom: "15px",
              borderRadius: "4px",
              border: "1px solid #ccc",
            }}
          />
        )}
        {/* Toggle for Active/Inactive Status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "10px",
          }}
        >
          <div
            style={{
              position: "relative",
              display: "inline-block",
              width: "50px",
              height: "24px",
            }}
          >
            <input
              type="checkbox"
              id="toggleActive"
              checked={selectedNode.active}
              onChange={handleToggleActive}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <label
              htmlFor="toggleActive"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: selectedNode.active ? "#4CAF50" : "#ccc",
                borderRadius: "24px",
                cursor: "pointer",
                transition: "background-color 0.2s",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  height: "20px",
                  width: "20px",
                  left: selectedNode.active ? "26px" : "4px",
                  bottom: "2px",
                  backgroundColor: "white",
                  borderRadius: "50%",
                  transition: "left 0.2s",
                }}
              ></span>
            </label>
          </div>
          <span style={{ marginLeft: "10px", fontWeight: "bold" }}>
            {selectedNode.active ? "Active" : "Inactive"}
          </span>
        </div>
        {/* Toggle for Suggestion Type */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "10px",
          }}
        >
          <div
            style={{
              position: "relative",
              display: "inline-block",
              width: "50px",
              height: "24px",
            }}
          >
            <input
              type="checkbox"
              id="toggleSuggestion"
              checked={suggestionType === "missing parts"}
              onChange={(e) =>
                setSuggestionType(e.target.checked ? "missing parts" : "all parts")
              }
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <label
              htmlFor="toggleSuggestion"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: suggestionType === "missing parts" ? "#4CAF50" : "#ccc",
                borderRadius: "24px",
                cursor: "pointer",
                transition: "background-color 0.2s",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  height: "20px",
                  width: "20px",
                  left: suggestionType === "missing parts" ? "26px" : "4px",
                  bottom: "2px",
                  backgroundColor: "white",
                  borderRadius: "50%",
                  transition: "left 0.2s",
                }}
              ></span>
            </label>
          </div>
          <span style={{ marginLeft: "10px", fontWeight: "bold" }}>
            {suggestionType === "missing parts" ? "Missing Parts" : "All Parts"}
          </span>
        </div>
        {/* Suggestions List */}
        {Object.keys(filteredSuggestions).length > 0 ? (
          Object.keys(filteredSuggestions).map((slotName) => {
            // Sort suggestions alphabetically by the part Name
            const sortedParts = filteredSuggestions[slotName]
              .slice()
              .sort((a, b) => a.Name.localeCompare(b.Name));
            return (
              <div key={slotName} style={{ marginBottom: "20px" }}>
                <h5>{slotName}</h5>
                <ul style={{ listStyleType: "none", padding: 0 }}>
                  {sortedParts.map((part) => (
                    <li
                      key={part.ID}
                      style={{
                        marginBottom: "10px",
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      <button
                        onClick={() => {
                          fetch("/api/add_item", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ item: part.ID }),
                            credentials: "include",
                          })
                            .then(() => {
                              fetchGraphData();
                              setSelectedNode(null);
                              setSuggestions({});
                            })
                            .catch((err) =>
                              console.error("Error adding suggested part:", err)
                            );
                        }}
                        style={{
                          cursor: "pointer",
                          backgroundColor: "#4CAF50",
                          color: "white",
                          border: "none",
                          borderRadius: "3px",
                          padding: "5px 8px",
                          marginRight: "10px",
                        }}
                      >
                        +
                      </button>
                      <span>
                        <strong>{part.ID}</strong> - {part.Name}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        ) : (
          <p style={{ margin: "10px 0" }}>No suggestions available.</p>
        )}
      </div>
    </div>
  </div>
)}

        <div
          style={{
            width: "calc(100%)",
            margin: "10px",
            backgroundColor: "#222",
            color: "white",
            textAlign: "center",
            padding: "10px",
            fontSize: "14px",
            borderRadius: "8px",
            whiteSpace: "pre-line",
          }}
        >
          {statusMessage}
        </div>
        {showCustomModal && pendingCustomEdge && (
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
      {/* Modal Header */}
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
        <h3 style={{ margin: 0, flex: 1 }}>Select a Slot to Connect</h3>
        <button
          onClick={() => {
            setShowCustomModal(false);
            setPendingCustomEdge(null);
          }}
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
          }}
        >
         <svg
            width="24"
            height="24"
            viewBox="1 -1 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <line x1="4" y1="7" x2="16" y2="19" stroke="white" strokeWidth="4" />
            <line x1="16" y1="7" x2="4" y2="19" stroke="white" strokeWidth="4" />
          </svg>
        </button>
      </div>
      {/* Modal Content */}
      <div style={{ padding: "20px" }}>
        <p>
          Source: <strong>{pendingCustomEdge.source}</strong>
        </p>
        <p>
          Target: <strong>{pendingCustomEdge.target}</strong>
        </p>
        <ul style={{ listStyleType: "none", padding: 0 }}>
          {availableSlots.length > 0 ? (
            availableSlots.map((slot) => (
              <li
                key={slot}
                style={{
                  marginBottom: "10px",
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid #eee",
                  paddingBottom: "5px",
                }}
              >
                <button
                  onClick={() => {
                    const chosenSlotName = slot;
                    fetch("/api/connect_custom", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        source: pendingCustomEdge.source,
                        target: pendingCustomEdge.target,
                        slot: chosenSlotName,
                      }),
                      credentials: "include",
                    })
                      .then((res) => {
                        if (!res.ok) {
                          return res
                            .json()
                            .then((data) => {
                              throw new Error(data.error || "Error");
                            });
                        }
                        return res.json();
                      })
                      .then(() => {
                        setShowCustomModal(false);
                        setPendingCustomEdge(null);
                        fetchGraphData(); // refresh the graph
                      })
                      .catch((err) =>
                        console.error("Error connecting custom slot:", err)
                      );
                  }}
                  style={{
                    cursor: "pointer",
                    backgroundColor: "#4CAF50",
                    color: "white",
                    border: "none",
                    borderRadius: "3px",
                    padding: "5px 8px",
                    marginRight: "10px",
                  }}
                >
                  +
                </button>
                <span style={{ fontSize: "16px" }}>
                  Slot: {slot}
                </span>
              </li>
            ))
          ) : (
            <li style={{ fontSize: "16px" }}>No available slots found.</li>
          )}
        </ul>
      </div>
    </div>
  </div>
)}


        {showHelp && renderHelpModal()}
        {graphData.warnings && graphData.warnings.length > 0 && (
          <div 
            onClick={() => setShowWarnings(true)}
            style={{
              position: 'fixed',
              bottom: '20px',
              left: '20px',
              cursor: 'pointer',
              zIndex: 11000
            }}
          >
            {/* Replace with your warning icon image source or SVG */}
            <img src="/images/warning.png" alt="Warning" style={{width: '80px', height: '80px'}} />
          </div>
        )}
        {showWarnings && (
  <div
    style={{
      position: "fixed",
      top: 0,
      left: 0,
      width: "100vw",
      height: "100vh",
      backgroundColor: "rgba(0, 0, 0, 0.4)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 9999,
    }}
  >
    <div
      style={{
        backgroundColor: "#fff",
        border: "1px solid #ddd",
        borderRadius: "5px",
        width: "500px",
        maxHeight: "80vh",
        overflowY: "auto",
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.2)",
        position: "relative",
        padding: "20px",
      }}
    >
      {/* Modal Header */}
      <div
        style={{
          position: "sticky",
          top: 0,
          left: 0,
          backgroundColor: "#fff",
          zIndex: 10,
          paddingBottom: "10px",
          borderBottom: "1px solid #ddd",
          display: "flex",
          alignItems: "center",
        }}
      >
        <button
          onClick={() => setShowWarnings(false)}
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
          <svg
            width="24"
            height="24"
            viewBox="1 -1 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <line x1="4" y1="7" x2="16" y2="19" stroke="white" strokeWidth="4" />
            <line x1="16" y1="7" x2="4" y2="19" stroke="white" strokeWidth="4" />
          </svg>
        </button>
        <h4 style={{ margin: 0 }}>Warnings</h4>
      </div>
      {/* Modal Content */}
      <div style={{ paddingTop: "10px" }}>
        <ul style={{ listStyleType: "none", padding: 0 }}>
          {graphData.warnings &&
            graphData.warnings.map((warning, index) => {
              // Look for a pattern like (PARTID) in the warning text.
              const match = warning.match(/\(([^)]+)\)/);
              const partId = match ? match[1] : null;
              return (
                <li
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    borderBottom: "1px solid #ddd",
                    padding: "8px 0",
                  }}
                >
                  <span>{warning}</span>
                  {partId && (
                    <button
                      onClick={() => {
                        fetch("/api/add_item", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ item: partId }),
                          credentials: "include",
                        })
                          .then(() => fetchGraphData())
                          .catch((err) =>
                            console.error("Error adding part:", err)
                          );
                      }}
                      style={{
                        cursor: "pointer",
                        backgroundColor: "#4CAF50",
                        color: "white",
                        border: "none",
                        borderRadius: "3px",
                        padding: "5px 8px",
                        marginLeft: "10px",
                      }}
                    >
                      +
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  </div>
)}


      </div>
    </div>
  );
}
